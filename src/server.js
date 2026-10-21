import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';
import { SUPPORTED_LANGUAGES, format, getMessages, pickLanguage } from './messages.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BROWSER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const FIELD_NAME_RE = /^[A-Za-z_]\w*$/;
const RESERVED_FIELDS = new Set(['email', 'browserId', 'language', 'lang', 'token']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logon_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logon_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES logon_users(id) ON DELETE CASCADE,
  browser_id TEXT NOT NULL,
  session_hash TEXT UNIQUE,
  user_agent TEXT,
  verified_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, browser_id)
);
CREATE TABLE IF NOT EXISTS logon_verification_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES logon_devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
`;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');
const CONFIRM_CODE_ATTEMPTS = 5;

// Hashed together with the link token, so a copy of the database alone cannot be brute-forced.
const confirmCodeHash = (linkToken, code) => sha256(`${linkToken}:${code}`);

// Databases created by older versions do not have the code columns yet.
function addMissingColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function fail(res, status, code, field) {
  return res.status(status).json({ error: field ? { code, field } : { code } });
}

function renderPage(language, title, body) {
  const m = getMessages(language);
  return `<!doctype html>
<html lang="${m.page.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
button { font: inherit; padding: 0.6rem 1.2rem; cursor: pointer; }
input { font: inherit; display: block; box-sizing: border-box; width: 100%; margin: 0.5rem 0 1rem; padding: 0.5rem; font-size: 1.4rem; letter-spacing: 0.3em; }
.logon-error { color: #b42318; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function renderVerifyPage({ language, appName, action, token, valid, requireCode = false, error = '' }) {
  const m = getMessages(language).ui;
  const title = escapeHtml(format(m.verifyTitle, { appName }));
  if (!valid) {
    return renderPage(language, m.verifyTitle, `<h1>${title}</h1><p>${escapeHtml(m.verifyFailed)}</p>`);
  }
  const codeField = requireCode
    ? `<label>${escapeHtml(m.confirmCodeLabel)}
<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>`
    : '';
  return renderPage(
    language,
    m.verifyTitle,
    `<h1>${title}</h1>
<p>${escapeHtml(format(m.verifyText, { appName }))}</p>
${error ? `<p class="logon-error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="language" value="${escapeHtml(language)}">
${codeField}
<button type="submit">${escapeHtml(m.verifyButton)}</button>
</form>`,
  );
}

function renderVerifyDone(language, appName, outcome) {
  const m = getMessages(language).ui;
  const body =
    outcome === 'ok'
      ? `<h1>${escapeHtml(format(m.verifyTitle, { appName }))}</h1><p>${escapeHtml(m.verifyDone)}</p>`
      : `<h1>${escapeHtml(format(m.verifyTitle, { appName }))}</h1><p>${escapeHtml(
          outcome === 'other_browser' ? m.verifyOtherBrowser : m.verifyFailed,
        )}</p>`;
  return renderPage(language, m.verifyTitle, body);
}

function normalizeField(field) {
  if (!field || typeof field.name !== 'string' || !FIELD_NAME_RE.test(field.name)) {
    throw new TypeError(`createLogon: invalid field name "${field?.name}"`);
  }
  if (RESERVED_FIELDS.has(field.name)) {
    throw new TypeError(`createLogon: field name "${field.name}" is reserved`);
  }
  let pattern;
  if (field.pattern instanceof RegExp) pattern = field.pattern;
  else if (typeof field.pattern === 'string') pattern = new RegExp(field.pattern);
  return { ...field, pattern };
}

function serializeField(field) {
  return {
    name: field.name,
    label: field.label ?? field.name,
    required: Boolean(field.required),
    maxLength: field.maxLength,
    inputType: field.inputType ?? 'text',
    autocomplete: field.autocomplete,
    placeholder: field.placeholder,
    pattern: field.pattern ? field.pattern.source : undefined,
  };
}

function validateProfile(body, fields) {
  const values = {};
  for (const field of fields) {
    const raw = body?.[field.name];
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!value) {
      if (field.required) return { error: { code: 'field_required', field: field.name } };
      values[field.name] = '';
      continue;
    }
    if (field.maxLength && value.length > field.maxLength) {
      return { error: { code: 'field_too_long', field: field.name } };
    }
    if (field.inputType === 'email' && !EMAIL_RE.test(value)) {
      return { error: { code: 'field_invalid', field: field.name } };
    }
    if (field.pattern && !field.pattern.test(value)) {
      return { error: { code: 'field_invalid', field: field.name } };
    }
    values[field.name] = value;
  }
  return { values };
}

/**
 * Creates a passwordless e-mail login backed by SQLite.
 *
 * @param {object} options
 * @param {(message: {to: string, subject: string, text: string, link: string, language: string, appName: string}) => Promise<void>} options.sendMail
 * @param {string | import('better-sqlite3').Database} [options.database='logon.db'] File path or an existing better-sqlite3 database.
 * @param {string} [options.appName='App']
 * @param {Array<object>} [options.fields=[]] Extra profile fields: {name, label, required, maxLength, pattern, inputType, autocomplete, placeholder}.
 * @param {number} [options.sessionDays=365]
 * @param {number} [options.linkMinutes=30]
 * @param {string} [options.cookieName='logon_session']
 * @param {string} [options.publicBaseUrl] Origin used in links, e.g. https://app.example.com. Recommended in production.
 * @param {string} [options.defaultLanguage='en']
 * @param {{error: Function} | null} [options.logger=console] Set to null to silence mail errors.
 * @param {boolean} [options.bindLinkToBrowser=false] Only accept a link in the browser that requested it. Blocks login if someone else gets you to click the link. Does not work when the link is confirmed on another device, such as a phone.
 * @param {boolean} [options.requireConfirmCode=false] Show a 6-digit code to the requesting browser and require it when the link is confirmed, also from another device. The code is never sent by e-mail.
 */
export function createLogon(options = {}) {
  const {
    sendMail,
    database = 'logon.db',
    appName = 'App',
    fields = [],
    sessionDays = 365,
    linkMinutes = 30,
    cookieName = 'logon_session',
    publicBaseUrl,
    defaultLanguage = 'en',
    logger = console,
    bindLinkToBrowser = false,
    requireConfirmCode = false,
  } = options;

  if (typeof sendMail !== 'function') {
    throw new TypeError('createLogon: sendMail must be a function');
  }

  const normalizedFields = fields.map(normalizeField);
  const ownsDatabase = typeof database === 'string';
  const db = ownsDatabase ? new Database(database) : database;
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  addMissingColumns(db, 'logon_verification_tokens', {
    confirm_code_hash: 'TEXT',
    confirm_attempts: 'INTEGER NOT NULL DEFAULT 0',
  });

  const baseUrl = publicBaseUrl ? publicBaseUrl.replace(/\/+$/, '') : null;
  const sessionMs = sessionDays * DAY_MS;
  const linkMs = linkMinutes * MINUTE_MS;
  const fallbackLanguage = pickLanguage(defaultLanguage);

  const stmt = {
    upsertUser: db.prepare(
      `INSERT INTO logon_users (email, created_at) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET email = excluded.email
       RETURNING id`,
    ),
    upsertDevice: db.prepare(
      `INSERT INTO logon_devices (user_id, browser_id, session_hash, user_agent, verified_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(user_id, browser_id) DO UPDATE SET
         session_hash = excluded.session_hash,
         user_agent = excluded.user_agent,
         verified_at = NULL
       RETURNING id`,
    ),
    retireTokens: db.prepare(
      'UPDATE logon_verification_tokens SET used_at = ? WHERE device_id = ? AND used_at IS NULL',
    ),
    insertToken: db.prepare(
      `INSERT INTO logon_verification_tokens (device_id, token_hash, expires_at, created_at, confirm_code_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    findValidToken: db.prepare(
      `SELECT id, device_id, confirm_code_hash FROM logon_verification_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    ),
    recordCodeMiss: db.prepare(
      'UPDATE logon_verification_tokens SET confirm_attempts = confirm_attempts + 1 WHERE id = ? RETURNING confirm_attempts',
    ),
    markTokenUsed: db.prepare(
      'UPDATE logon_verification_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL',
    ),
    verifyDevice: db.prepare('UPDATE logon_devices SET verified_at = ?, last_used_at = ? WHERE id = ?'),
    deviceBySession: db.prepare(
      `SELECT d.id AS device_id, d.verified_at, d.last_used_at, u.id AS user_id, u.email, u.profile
       FROM logon_devices d JOIN logon_users u ON u.id = d.user_id
       WHERE d.session_hash = ?`,
    ),
    touchDevice: db.prepare('UPDATE logon_devices SET last_used_at = ? WHERE id = ?'),
    clearSession: db.prepare('UPDATE logon_devices SET session_hash = NULL, verified_at = NULL WHERE id = ?'),
    updateProfile: db.prepare('UPDATE logon_users SET profile = ? WHERE id = ?'),
  };

  function readCookie(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index !== -1 && part.slice(0, index).trim() === cookieName) {
        return part.slice(index + 1).trim();
      }
    }
    return null;
  }

  function sessionDeviceId(req) {
    const token = readCookie(req);
    if (!token) return null;
    const row = stmt.deviceBySession.get(sha256(token));
    return row ? row.device_id : null;
  }

  function currentUser(req) {
    const token = readCookie(req);
    if (!token) return null;
    const row = stmt.deviceBySession.get(sha256(token));
    if (!row || row.verified_at === null) return null;
    const now = Date.now();
    if (row.verified_at < now - sessionMs) return null;
    if (!row.last_used_at || now - row.last_used_at > MINUTE_MS) {
      stmt.touchDevice.run(now, row.device_id);
    }
    return {
      id: row.user_id,
      email: row.email,
      profile: JSON.parse(row.profile),
      deviceId: row.device_id,
    };
  }

  function resolveLanguage(req) {
    const acceptLanguage = (req.get('accept-language') || '')
      .split(',')
      .map((part) => part.split(';')[0].trim());
    const candidates = [req.body?.language, req.query?.lang, ...acceptLanguage];
    for (const candidate of candidates) {
      const language = pickLanguage(candidate, null);
      if (language) return language;
    }
    return fallbackLanguage;
  }

  function baseUrlFor(req) {
    if (baseUrl) return `${baseUrl}${req.baseUrl}`;
    return `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  }

  function isSecure(req) {
    return req.secure || (baseUrl ?? '').startsWith('https:');
  }

  function cookieOptions(req) {
    return { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/' };
  }

  function publicUser(user) {
    return { id: user.id, email: user.email, profile: user.profile };
  }

  function requireUser(req, res, next) {
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'unauthorized');
    req.logonUser = user;
    next();
  }

  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));
  router.use((err, req, res, next) => {
    if (err.expose) return fail(res, err.status, 'bad_request');
    next(err);
  });

  router.get('/config', (req, res) => {
    res.json({
      appName,
      sessionDays,
      linkMinutes,
      defaultLanguage: fallbackLanguage,
      languages: SUPPORTED_LANGUAGES,
      fields: normalizedFields.map(serializeField),
    });
  });

  router.get('/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = currentUser(req);
    res.json({ user: user ? publicUser(user) : null });
  });

  router.post('/request-link', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return fail(res, 422, 'invalid_email', 'email');

    const browserId = typeof req.body?.browserId === 'string' ? req.body.browserId : '';
    if (!BROWSER_ID_RE.test(browserId)) return fail(res, 400, 'bad_request');

    const language = resolveLanguage(req);
    const messages = getMessages(language).mail;
    const sessionToken = randomToken();
    const linkToken = randomToken();
    const confirmCode = requireConfirmCode
      ? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
      : null;
    const link = `${baseUrlFor(req)}/verify?token=${linkToken}&lang=${language}`;

    try {
      await sendMail({
        to: email,
        subject: format(messages.subject, { appName }),
        text: format(messages.text, { appName, link, minutes: linkMinutes }),
        link,
        language,
        appName,
      });
    } catch (error) {
      logger?.error?.('[logon] sendMail failed', error);
      return fail(res, 502, 'send_failed');
    }

    const now = Date.now();
    const userAgent = (req.get('user-agent') || '').slice(0, 255) || null;
    db.transaction(() => {
      const { id: userId } = stmt.upsertUser.get(email, now);
      const { id: deviceId } = stmt.upsertDevice.get(
        userId,
        browserId,
        sha256(sessionToken),
        userAgent,
        now,
      );
      stmt.retireTokens.run(now, deviceId);
      stmt.insertToken.run(
        deviceId,
        sha256(linkToken),
        now + linkMs,
        now,
        confirmCode ? confirmCodeHash(linkToken, confirmCode) : null,
      );
    })();

    res.cookie(cookieName, sessionToken, { ...cookieOptions(req), maxAge: sessionMs });
    res.json(confirmCode ? { ok: true, confirmCode } : { ok: true });
  });

  router.get('/verify', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const language = resolveLanguage(req);
    const valid = Boolean(token) && Boolean(stmt.findValidToken.get(sha256(token), Date.now()));
    res.set('Cache-Control', 'no-store');
    res.type('html').send(
      renderVerifyPage({
        language,
        appName,
        action: `${req.baseUrl}/verify`,
        token,
        valid,
        requireCode: requireConfirmCode,
      }),
    );
  });

  router.post('/verify', (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const language = resolveLanguage(req);
    const wantsJson =
      req.is('application/json') || (req.get('accept') || '').includes('application/json');

    const now = Date.now();
    const outcome = token
      ? db.transaction(() => {
          const row = stmt.findValidToken.get(sha256(token), now);
          if (!row) return 'invalid';
          if (bindLinkToBrowser && sessionDeviceId(req) !== row.device_id) return 'other_browser';
          if (requireConfirmCode && confirmCodeHash(token, code) !== row.confirm_code_hash) {
            const { confirm_attempts: misses } = stmt.recordCodeMiss.get(row.id);
            if (misses < CONFIRM_CODE_ATTEMPTS) return 'bad_code';
            stmt.markTokenUsed.run(now, row.id);
            return 'invalid';
          }
          const result = stmt.markTokenUsed.run(now, row.id);
          if (result.changes === 0) return 'invalid';
          stmt.verifyDevice.run(now, now, row.device_id);
          return 'ok';
        })()
      : 'invalid';

    if (wantsJson) {
      if (outcome === 'other_browser') return fail(res, 400, 'link_other_browser');
      if (outcome === 'bad_code') return fail(res, 400, 'link_code_invalid', 'code');
      if (outcome !== 'ok') return fail(res, 400, 'link_invalid');
      return res.json({ ok: true });
    }
    res.set('Cache-Control', 'no-store');
    if (outcome === 'bad_code') {
      return res
        .status(400)
        .type('html')
        .send(
          renderVerifyPage({
            language,
            appName,
            action: `${req.baseUrl}/verify`,
            token,
            valid: true,
            requireCode: true,
            error: getMessages(language).ui.verifyBadCode,
          }),
        );
    }
    res
      .status(outcome === 'ok' ? 200 : 400)
      .type('html')
      .send(renderVerifyDone(language, appName, outcome));
  });

  router.post('/logout', (req, res) => {
    const token = readCookie(req);
    if (token) {
      const row = stmt.deviceBySession.get(sha256(token));
      if (row) stmt.clearSession.run(row.device_id);
    }
    res.clearCookie(cookieName, cookieOptions(req));
    res.json({ ok: true });
  });

  router.patch('/profile', requireUser, (req, res) => {
    const result = validateProfile(req.body, normalizedFields);
    if (result.error) {
      return fail(res, 422, result.error.code, result.error.field);
    }
    stmt.updateProfile.run(JSON.stringify(result.values), req.logonUser.id);
    res.json({ user: publicUser({ ...req.logonUser, profile: result.values }) });
  });

  return {
    router,
    currentUser,
    requireUser,
    close() {
      if (ownsDatabase) db.close();
    },
  };
}
