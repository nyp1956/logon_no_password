import defaultMessages, {
  LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  format,
  pickLanguage,
} from './messages.js';

const BROWSER_KEY = 'logon.browserId';
const LANGUAGE_KEY = 'logon.language';
const GUEST_KEY = 'logon.guest';
const BROWSER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function safeStorage() {
  const get = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const set = (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable (private mode) */
    }
  };
  const remove = (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  };
  return { get, set, remove };
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const base = target[key] && typeof target[key] === 'object' ? target[key] : {};
      target[key] = deepMerge(base, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'className') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mounts the login dialog in the page and keeps the signed-in user in sync.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl='/api/logon'] Mount path of the server router.
 * @param {boolean} [options.allowGuest=true] Show a "continue without account" button.
 * @param {string} [options.language] Used when the user has not picked a language.
 * @param {object} [options.messages] Overrides for texts: {en: {ui, errors, mail}, da: {...}}.
 * @param {(state: {user: object|null, guest: boolean}) => void} [options.onChange]
 * @param {Element | string} [options.trigger] Element (or selector) that opens the dialog when clicked.
 * @param {number} [options.pollMs=4000]
 * @param {number} [options.pollMinutes=30] How long to poll for the link to be opened.
 */
export function mountLogon(options = {}) {
  const {
    baseUrl = '/api/logon',
    allowGuest = true,
    language: initialLanguage,
    messages: overrides = {},
    onChange = () => {},
    trigger,
    pollMs = 4000,
    pollMinutes = 30,
  } = options;

  const storage = safeStorage();
  const dictionaries = deepMerge(structuredClone(defaultMessages), overrides);
  const dictFor = (code) => dictionaries[code] ?? dictionaries.en;

  let lang =
    pickLanguage(storage.get(LANGUAGE_KEY), null) ||
    pickLanguage(initialLanguage, null) ||
    pickLanguage(globalThis.navigator?.language, 'en');

  let config = { appName: '', fields: [] };
  const state = {
    user: null,
    view: 'signin',
    email: '',
    confirmCode: '',
    error: '',
    notice: '',
  };

  let polling = false;
  let pollTimer = null;
  let pollDeadline = 0;

  const dialog = document.createElement('dialog');
  dialog.className = 'logon-dialog';
  dialog.setAttribute('aria-labelledby', 'logon-title');
  document.body.append(dialog);

  const t = (key, values) => {
    const text = dictFor(lang).ui[key] ?? dictionaries.en.ui[key] ?? key;
    return format(text, values);
  };

  const fieldLabel = (field) => {
    if (field.label && typeof field.label === 'object') {
      return field.label[lang] ?? field.label.en ?? field.name;
    }
    return field.label ?? field.name;
  };

  function errorText(error) {
    const code = error?.code || 'unknown';
    const errors = dictFor(lang).errors;
    const field = config.fields.find((f) => f.name === error?.field);
    const label = field ? fieldLabel(field) : error?.field || '';
    return format(errors[code] ?? dictionaries.en.errors[code] ?? errors.unknown, { field: label });
  }

  const isGuest = () => !state.user && storage.get(GUEST_KEY) === '1';

  function emit() {
    onChange({ user: state.user, guest: isGuest() });
  }

  function setUser(user) {
    const before = JSON.stringify(state.user);
    state.user = user;
    if (user) storage.remove(GUEST_KEY);
    if (JSON.stringify(user) !== before) emit();
  }

  async function api(path, { method = 'GET', body } = {}) {
    const init = { method, credentials: 'include', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, init);
    } catch {
      throw Object.assign(new Error('network'), { code: 'unknown' });
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw Object.assign(new Error('request failed'), {
        code: data?.error?.code || 'unknown',
        field: data?.error?.field,
        status: response.status,
      });
    }
    return data;
  }

  async function loadConfig() {
    try {
      config = await api('/config');
    } catch {
      /* keep defaults; the server may be unreachable */
    }
  }

  async function refresh() {
    try {
      const { user } = await api('/session');
      setUser(user);
      return user;
    } catch {
      return state.user;
    }
  }

  function stopPolling() {
    polling = false;
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function scheduleTick() {
    pollTimer = setTimeout(tick, pollMs);
  }

  async function tick() {
    pollTimer = null;
    if (!polling) return;
    if (Date.now() > pollDeadline) {
      stopPolling();
      state.error = t('linkExpired');
      if (dialog.open) render();
      return;
    }
    const user = await refresh();
    if (!polling) return;
    if (user) {
      stopPolling();
      state.view = 'profile';
      state.error = '';
      if (dialog.open) render();
      return;
    }
    scheduleTick();
  }

  function startPolling() {
    stopPolling();
    polling = true;
    pollDeadline = Date.now() + pollMinutes * 60 * 1000;
    scheduleTick();
  }

  async function requestLink(email) {
    state.error = '';
    state.confirmCode = '';
    try {
      const result = await api('/request-link', {
        method: 'POST',
        body: { email, browserId: getBrowserId(), language: lang },
      });
      state.email = email;
      state.confirmCode = result?.confirmCode || '';
      state.view = 'waiting';
      startPolling();
    } catch (error) {
      state.error = errorText(error);
    }
    render();
  }

  async function saveProfile(form) {
    const body = {};
    for (const field of config.fields) {
      body[field.name] = form.elements[field.name]?.value ?? '';
    }
    state.error = '';
    try {
      const { user } = await api('/profile', { method: 'PATCH', body });
      state.user = user;
      state.notice = t('saved');
      emit();
    } catch (error) {
      state.error = errorText(error);
    }
    render();
  }

  async function signOut() {
    try {
      await api('/logout', { method: 'POST' });
    } catch {
      /* clear local state even if the request fails */
    }
    stopPolling();
    storage.remove(GUEST_KEY);
    state.user = null;
    state.view = 'signin';
    state.error = '';
    state.notice = '';
    emit();
    render();
  }

  function continueAsGuest() {
    stopPolling();
    storage.set(GUEST_KEY, '1');
    state.error = '';
    emit();
    close();
  }

  function setLanguage(code) {
    lang = code;
    storage.set(LANGUAGE_KEY, code);
    render();
  }

  function getBrowserId() {
    let id = storage.get(BROWSER_KEY);
    if (!id || !BROWSER_ID_RE.test(id)) {
      id = randomId();
      storage.set(BROWSER_KEY, id);
    }
    return id;
  }

  function errorLine() {
    return state.error ? h('p', { className: 'logon-error', role: 'alert', text: state.error }) : null;
  }

  function noticeLine() {
    return state.notice ? h('p', { className: 'logon-notice', role: 'status', text: state.notice }) : null;
  }

  function signinView() {
    const form = h(
      'form',
      {
        className: 'logon-form',
        onsubmit: (event) => {
          event.preventDefault();
          requestLink(state.email.trim());
        },
      },
      h(
        'label',
        {},
        h('span', { text: t('emailLabel') }),
        h('input', {
          type: 'email',
          name: 'email',
          required: true,
          autocomplete: 'email',
          value: state.email,
          oninput: (event) => {
            state.email = event.target.value;
          },
        }),
      ),
      h('button', { type: 'submit', text: t('sendLink') }),
      allowGuest
        ? h('button', { type: 'button', className: 'logon-secondary', onclick: continueAsGuest, text: t('guest') })
        : null,
      isGuest() ? h('p', { className: 'logon-muted', text: t('guestMode') }) : null,
      errorLine(),
    );
    return form;
  }

  function waitingView() {
    return h(
      'div',
      { className: 'logon-form' },
      h('p', { text: t('waiting', { email: state.email }) }),
      state.confirmCode ? h('p', { text: t('confirmCodeShow') }) : null,
      state.confirmCode ? h('p', { className: 'logon-code', text: state.confirmCode }) : null,
      errorLine(),
      h('button', {
        type: 'button',
        className: 'logon-secondary',
        onclick: () => {
          state.view = 'signin';
          state.error = '';
          render();
        },
        text: t('resend'),
      }),
    );
  }

  function profileView() {
    const profile = state.user.profile || {};
    return h(
      'form',
      {
        className: 'logon-form',
        onsubmit: (event) => {
          event.preventDefault();
          saveProfile(event.currentTarget);
        },
      },
      h('p', { className: 'logon-muted', text: t('signedInAs', { email: state.user.email }) }),
      config.fields.map((field) =>
        h(
          'label',
          {},
          h('span', { text: fieldLabel(field) }),
          h('input', {
            name: field.name,
            type: field.inputType || 'text',
            required: field.required,
            maxlength: field.maxLength,
            pattern: field.pattern,
            autocomplete: field.autocomplete,
            placeholder: field.placeholder,
            value: profile[field.name] ?? '',
          }),
        ),
      ),
      config.fields.length ? h('button', { type: 'submit', text: t('save') }) : null,
      noticeLine(),
      errorLine(),
      h('button', { type: 'button', className: 'logon-secondary', onclick: signOut, text: t('signOut') }),
    );
  }

  function render() {
    const body = state.user ? profileView() : state.view === 'waiting' ? waitingView() : signinView();
    const languageSelect = h(
      'select',
      {
        className: 'logon-language',
        'aria-label': t('language'),
        onchange: (event) => setLanguage(event.target.value),
      },
      SUPPORTED_LANGUAGES.map((code) => h('option', { value: code, text: LANGUAGE_NAMES[code] })),
    );
    languageSelect.value = lang;

    dialog.replaceChildren(
      h(
        'div',
        { className: 'logon-header' },
        h('h2', { id: 'logon-title', text: state.user ? t('profileTitle') : t('title') }),
        h('button', { type: 'button', className: 'logon-close', 'aria-label': t('close'), text: '×', onclick: close }),
      ),
      body,
      h('div', { className: 'logon-footer' }, languageSelect),
    );
  }

  function open() {
    if (state.user) state.view = 'profile';
    else if (state.view === 'profile') state.view = 'signin';
    state.error = '';
    state.notice = '';
    render();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector('input')?.focus();
  }

  function close() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  const triggerEl = typeof trigger === 'string' ? document.querySelector(trigger) : trigger;
  triggerEl?.addEventListener('click', open);

  const ready = Promise.all([loadConfig(), refresh()]).then(() => undefined);

  return {
    open,
    close,
    refresh,
    signOut,
    getUser: () => state.user,
    isGuest,
    ready,
    destroy() {
      stopPolling();
      triggerEl?.removeEventListener('click', open);
      dialog.remove();
    },
  };
}
