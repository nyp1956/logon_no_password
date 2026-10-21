import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createLogon } from '../src/server.js';

const COOKIE = 'logon_session';
const BROWSER_ID = 'browser-test-0001';

async function startServer(options = {}) {
  const sent = [];
  const logon = createLogon({
    database: ':memory:',
    appName: 'Test app',
    logger: null,
    sendMail: async (message) => {
      sent.push(message);
    },
    fields: [{ name: 'displayName', label: 'Name', required: true, maxLength: 20 }],
    ...options,
  });
  const app = express();
  app.use('/api/logon', logon.router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/logon`;
  return {
    logon,
    sent,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      logon.close();
    },
  };
}

function makeClient(base) {
  let cookie = null;
  async function request(path, { method = 'GET', body, accept } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (accept) headers.accept = accept;
    let payload;
    if (body instanceof URLSearchParams) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = body.toString();
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
    for (const setCookie of res.headers.getSetCookie()) {
      const match = setCookie.match(/^([^=]+)=([^;]*)/);
      if (match && match[1] === COOKIE) cookie = match[2] === '' ? null : `${match[1]}=${match[2]}`;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: res.status, data, text };
  }
  return {
    request,
    cookie: () => cookie,
    hasCookie: () => cookie !== null,
  };
}

function tokenFrom(message) {
  return new URL(message.link).searchParams.get('token');
}

async function signIn(ctx, client, email = 'anna@example.com') {
  const requested = await client.request('/request-link', {
    method: 'POST',
    body: { email, browserId: BROWSER_ID },
  });
  assert.equal(requested.status, 200);
  const message = ctx.sent.at(-1);
  const verified = await client.request('/verify', {
    method: 'POST',
    body: { token: tokenFrom(message) },
    accept: 'application/json',
  });
  assert.equal(verified.status, 200);
  return message;
}

test('request-link sends a magic link and sets a session cookie', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    const res = await client.request('/request-link', {
      method: 'POST',
      body: { email: 'Anna@Example.com ', browserId: BROWSER_ID, language: 'da' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(client.hasCookie(), true);
    assert.equal(ctx.sent.length, 1);
    const [message] = ctx.sent;
    assert.equal(message.to, 'anna@example.com');
    assert.equal(message.language, 'da');
    assert.match(message.link, /\/api\/logon\/verify\?token=[0-9a-f]{64}&lang=da$/);
    assert.match(message.subject, /Test app/);
    assert.ok(message.text.includes(message.link));
  } finally {
    await ctx.close();
  }
});

test('session has no user until the link is confirmed', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    await client.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    const before = await client.request('/session');
    assert.deepEqual(before.data, { user: null });

    const message = ctx.sent[0];
    const verified = await client.request('/verify', {
      method: 'POST',
      body: { token: tokenFrom(message) },
      accept: 'application/json',
    });
    assert.deepEqual(verified.data, { ok: true });

    const after = await client.request('/session');
    assert.equal(after.data.user.email, 'anna@example.com');
    assert.deepEqual(after.data.user.profile, {});
  } finally {
    await ctx.close();
  }
});

test('a link can only be used once', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    await client.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    const token = tokenFrom(ctx.sent[0]);
    const first = await client.request('/verify', { method: 'POST', body: { token }, accept: 'application/json' });
    const second = await client.request('/verify', { method: 'POST', body: { token }, accept: 'application/json' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 400);
    assert.equal(second.data.error.code, 'link_invalid');
  } finally {
    await ctx.close();
  }
});

test('by default a link can be verified from another browser', async () => {
  const ctx = await startServer();
  try {
    const requester = makeClient(ctx.base);
    const other = makeClient(ctx.base);
    await requester.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    const verified = await other.request('/verify', {
      method: 'POST',
      body: { token: tokenFrom(ctx.sent[0]) },
      accept: 'application/json',
    });
    assert.equal(verified.status, 200);
    const session = await requester.request('/session');
    assert.equal(session.data.user.email, 'anna@example.com');
  } finally {
    await ctx.close();
  }
});

test('bindLinkToBrowser rejects a link opened in another browser without consuming it', async () => {
  const ctx = await startServer({ bindLinkToBrowser: true });
  try {
    const requester = makeClient(ctx.base);
    const other = makeClient(ctx.base);
    await requester.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    const token = tokenFrom(ctx.sent[0]);

    const rejected = await other.request('/verify', { method: 'POST', body: { token }, accept: 'application/json' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.error.code, 'link_other_browser');
    assert.equal((await other.request('/session')).data.user, null);

    const verified = await requester.request('/verify', { method: 'POST', body: { token }, accept: 'application/json' });
    assert.equal(verified.status, 200);
    assert.equal((await requester.request('/session')).data.user.email, 'anna@example.com');
  } finally {
    await ctx.close();
  }
});

test('requireConfirmCode is off by default and returns no code', async () => {
  const ctx = await startServer();
  try {
    const requester = makeClient(ctx.base);
    const requested = await requester.request('/request-link', {
      method: 'POST',
      body: { email: 'anna@example.com', browserId: BROWSER_ID },
    });
    assert.equal(requested.data.confirmCode, undefined);
  } finally {
    await ctx.close();
  }
});

test('requireConfirmCode returns the code only to the requester and never in the mail', async () => {
  const ctx = await startServer({ requireConfirmCode: true });
  try {
    const requester = makeClient(ctx.base);
    const requested = await requester.request('/request-link', {
      method: 'POST',
      body: { email: 'anna@example.com', browserId: BROWSER_ID },
    });
    const code = requested.data.confirmCode;
    assert.match(code, /^\d{6}$/);
    const message = ctx.sent.at(-1);
    assert.equal(message.text.includes(code), false);
    assert.equal(message.link.includes(code), false);
  } finally {
    await ctx.close();
  }
});

test('requireConfirmCode accepts the right code from another device', async () => {
  const ctx = await startServer({ requireConfirmCode: true });
  try {
    const requester = makeClient(ctx.base);
    const phone = makeClient(ctx.base);
    const requested = await requester.request('/request-link', {
      method: 'POST',
      body: { email: 'anna@example.com', browserId: BROWSER_ID },
    });
    const verified = await phone.request('/verify', {
      method: 'POST',
      body: { token: tokenFrom(ctx.sent.at(-1)), code: requested.data.confirmCode },
      accept: 'application/json',
    });
    assert.equal(verified.status, 200);
    assert.equal((await requester.request('/session')).data.user.email, 'anna@example.com');
    assert.equal((await phone.request('/session')).data.user, null);
  } finally {
    await ctx.close();
  }
});

test('requireConfirmCode rejects a wrong code without consuming the link', async () => {
  const ctx = await startServer({ requireConfirmCode: true });
  try {
    const requester = makeClient(ctx.base);
    const phone = makeClient(ctx.base);
    const requested = await requester.request('/request-link', {
      method: 'POST',
      body: { email: 'anna@example.com', browserId: BROWSER_ID },
    });
    const token = tokenFrom(ctx.sent.at(-1));
    const wrong = requested.data.confirmCode === '000000' ? '111111' : '000000';

    const miss = await phone.request('/verify', {
      method: 'POST',
      body: { token, code: wrong },
      accept: 'application/json',
    });
    assert.equal(miss.status, 400);
    assert.equal(miss.data.error.code, 'link_code_invalid');
    assert.equal(miss.data.error.field, 'code');

    const right = await phone.request('/verify', {
      method: 'POST',
      body: { token, code: requested.data.confirmCode },
      accept: 'application/json',
    });
    assert.equal(right.status, 200);
  } finally {
    await ctx.close();
  }
});

test('requireConfirmCode consumes the link after five wrong codes', async () => {
  const ctx = await startServer({ requireConfirmCode: true });
  try {
    const requester = makeClient(ctx.base);
    const phone = makeClient(ctx.base);
    const requested = await requester.request('/request-link', {
      method: 'POST',
      body: { email: 'anna@example.com', browserId: BROWSER_ID },
    });
    const token = tokenFrom(ctx.sent.at(-1));
    const wrong = requested.data.confirmCode === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      await phone.request('/verify', { method: 'POST', body: { token, code: wrong }, accept: 'application/json' });
    }
    const after = await phone.request('/verify', {
      method: 'POST',
      body: { token, code: requested.data.confirmCode },
      accept: 'application/json',
    });
    assert.equal(after.status, 400);
    assert.equal(after.data.error.code, 'link_invalid');
    assert.equal((await requester.request('/session')).data.user, null);
  } finally {
    await ctx.close();
  }
});

test('the confirm page asks for the code when requireConfirmCode is on', async () => {
  const ctx = await startServer({ requireConfirmCode: true });
  try {
    const requester = makeClient(ctx.base);
    await requester.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    const page = await requester.request(`/verify?token=${tokenFrom(ctx.sent.at(-1))}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /name="code"/);
  } finally {
    await ctx.close();
  }
});

test('opening the confirm page does not consume the link', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    await client.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    const token = tokenFrom(ctx.sent[0]);

    const page = await client.request(`/verify?token=${token}&lang=en`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<form method="post"/);
    assert.ok(page.text.includes(`value="${token}"`));

    const confirmed = await client.request('/verify', {
      method: 'POST',
      body: new URLSearchParams({ token }),
      accept: 'text/html',
    });
    assert.equal(confirmed.status, 200);
    assert.match(confirmed.text, /You are signed in/);
  } finally {
    await ctx.close();
  }
});

test('an invalid token shows the failure page', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    const page = await client.request('/verify?token=deadbeef&lang=en');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /<form/);
    assert.match(page.text, /invalid or has expired/);
  } finally {
    await ctx.close();
  }
});

test('an expired link is rejected', async () => {
  const ctx = await startServer({ linkMinutes: 0 });
  try {
    const client = makeClient(ctx.base);
    await client.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    const res = await client.request('/verify', {
      method: 'POST',
      body: { token: tokenFrom(ctx.sent[0]) },
      accept: 'application/json',
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'link_invalid');
  } finally {
    await ctx.close();
  }
});

test('a newer link retires the older one for the same browser', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    await client.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    await client.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    const oldRes = await client.request('/verify', {
      method: 'POST',
      body: { token: tokenFrom(ctx.sent[0]) },
      accept: 'application/json',
    });
    const newRes = await client.request('/verify', {
      method: 'POST',
      body: { token: tokenFrom(ctx.sent[1]) },
      accept: 'application/json',
    });
    assert.equal(oldRes.status, 400);
    assert.equal(newRes.status, 200);
  } finally {
    await ctx.close();
  }
});

test('confirming from another device still signs in the requesting browser', async () => {
  const ctx = await startServer();
  try {
    const browser = makeClient(ctx.base);
    const phone = makeClient(ctx.base);
    await browser.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    await phone.request('/verify', { method: 'POST', body: { token: tokenFrom(ctx.sent[0]) }, accept: 'application/json' });
    const session = await browser.request('/session');
    assert.equal(session.data.user.email, 'anna@example.com');
    assert.equal((await phone.request('/session')).data.user, null);
  } finally {
    await ctx.close();
  }
});

test('invalid e-mail is rejected with a field error', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    const res = await client.request('/request-link', { method: 'POST', body: { email: 'not-an-email', browserId: BROWSER_ID } });
    assert.equal(res.status, 422);
    assert.deepEqual(res.data.error, { code: 'invalid_email', field: 'email' });
    assert.equal(ctx.sent.length, 0);
  } finally {
    await ctx.close();
  }
});

test('a missing browser id is a bad request', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    const res = await client.request('/request-link', { method: 'POST', body: { email: 'anna@example.com' } });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'bad_request');
  } finally {
    await ctx.close();
  }
});

test('request-link is rate limited per client after the configured number of calls', async () => {
  const ctx = await startServer({ requestLinkLimit: { max: 2, windowMinutes: 15 } });
  try {
    const client = makeClient(ctx.base);
    const body = { email: 'anna@example.com', browserId: BROWSER_ID };
    assert.equal((await client.request('/request-link', { method: 'POST', body })).status, 200);
    assert.equal((await client.request('/request-link', { method: 'POST', body })).status, 200);
    const limited = await client.request('/request-link', { method: 'POST', body });
    assert.equal(limited.status, 429);
    assert.equal(limited.data.error.code, 'rate_limited');
    assert.equal(ctx.sent.length, 2);
  } finally {
    await ctx.close();
  }
});

test('requestLinkLimit: false disables the request-link limiter', async () => {
  const ctx = await startServer({ requestLinkLimit: false });
  try {
    const client = makeClient(ctx.base);
    const body = { email: 'anna@example.com', browserId: BROWSER_ID };
    for (let i = 0; i < 7; i += 1) {
      assert.equal((await client.request('/request-link', { method: 'POST', body })).status, 200);
    }
  } finally {
    await ctx.close();
  }
});

test('an invalid requestLinkLimit is rejected', () => {
  assert.throws(
    () => createLogon({ sendMail: async () => {}, database: ':memory:', logger: null, requestLinkLimit: { max: 0, windowMinutes: 15 } }),
    TypeError,
  );
});

test('a failing mail sender reports send_failed and creates no session', async () => {
  const ctx = await startServer({
    sendMail: async () => {
      throw new Error('smtp down');
    },
  });
  try {
    const client = makeClient(ctx.base);
    const res = await client.request('/request-link', { method: 'POST', body: { email: 'anna@example.com', browserId: BROWSER_ID } });
    assert.equal(res.status, 502);
    assert.equal(res.data.error.code, 'send_failed');
    assert.equal(client.hasCookie(), false);
  } finally {
    await ctx.close();
  }
});

test('profile requires a signed-in user', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    const res = await client.request('/profile', { method: 'PATCH', body: { displayName: 'Anna' } });
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'unauthorized');
  } finally {
    await ctx.close();
  }
});

test('profile validates required fields and saves valid values', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    await signIn(ctx, client);

    const missing = await client.request('/profile', { method: 'PATCH', body: { displayName: '  ' } });
    assert.equal(missing.status, 422);
    assert.deepEqual(missing.data.error, { code: 'field_required', field: 'displayName' });

    const tooLong = await client.request('/profile', { method: 'PATCH', body: { displayName: 'x'.repeat(21) } });
    assert.equal(tooLong.status, 422);
    assert.equal(tooLong.data.error.code, 'field_too_long');

    const saved = await client.request('/profile', { method: 'PATCH', body: { displayName: ' Anna ' } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.user.profile, { displayName: 'Anna' });

    const session = await client.request('/session');
    assert.deepEqual(session.data.user.profile, { displayName: 'Anna' });
  } finally {
    await ctx.close();
  }
});

test('logout invalidates the session', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    await signIn(ctx, client);
    assert.equal((await client.request('/session')).data.user !== null, true);

    const out = await client.request('/logout', { method: 'POST' });
    assert.equal(out.status, 200);
    assert.equal(client.hasCookie(), false);
    assert.equal((await client.request('/session')).data.user, null);
    assert.equal((await client.request('/profile', { method: 'PATCH', body: { displayName: 'Anna' } })).status, 401);
  } finally {
    await ctx.close();
  }
});

test('logout with a replayed old cookie does not restore the session', async () => {
  const ctx = await startServer();
  try {
    const client = makeClient(ctx.base);
    await signIn(ctx, client);
    const stolen = client.cookie();
    await client.request('/logout', { method: 'POST' });

    const res = await fetch(`${ctx.base}/session`, { headers: { cookie: stolen } });
    assert.deepEqual(await res.json(), { user: null });
  } finally {
    await ctx.close();
  }
});

test('config exposes fields without secrets', async () => {
  const ctx = await startServer({
    fields: [{ name: 'fide', label: { en: 'FIDE ID', da: 'FIDE-ID' }, pattern: /^\d*$/, maxLength: 10 }],
  });
  try {
    const client = makeClient(ctx.base);
    const res = await client.request('/config');
    assert.equal(res.status, 200);
    assert.equal(res.data.appName, 'Test app');
    assert.deepEqual(res.data.languages, ['en', 'da']);
    assert.deepEqual(res.data.fields, [
      {
        name: 'fide',
        label: { en: 'FIDE ID', da: 'FIDE-ID' },
        required: false,
        maxLength: 10,
        inputType: 'text',
        pattern: '^\\d*$',
      },
    ]);
  } finally {
    await ctx.close();
  }
});

test('reserved and malformed field names are rejected', () => {
  const sendMail = async () => {};
  assert.throws(
    () => createLogon({ sendMail, database: ':memory:', fields: [{ name: 'email' }] }),
    /reserved/,
  );
  assert.throws(
    () => createLogon({ sendMail, database: ':memory:', fields: [{ name: 'bad name' }] }),
    /invalid field name/,
  );
});
