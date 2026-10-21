# logon_no_password

Passwordless login for Node.js apps. Users enter their e-mail, receive a single-use
magic link, and confirm it. The browser that asked for the link is then signed in,
even if the link was opened on another device.

- No passwords are stored or asked for.
- Each browser holds a random session cookie. The server stores only its SHA-256 hash.
- Links are single-use and expire after 30 minutes by default.
- The confirm page is a form that must be submitted with POST, so e-mail link
  scanners cannot consume the link by opening it.
- Optional guest mode, and an optional profile form with custom fields.
- Built-in English and Danish texts. You can override any text.

The package has two parts:

- `createLogon()` (server): an Express router with SQLite storage.
- `mountLogon()` (browser): a login dialog that polls until the link is confirmed.

## Install

```bash
npm install logon_no_password express
```

`express` is a peer dependency (`^4.18.0 || ^5.0.0`). The package uses
`better-sqlite3`, which needs a prebuilt binary or a C++ toolchain on install.

## Server

```js
import express from 'express';
import { createLogon } from 'logon_no_password';

const app = express();

const logon = createLogon({
  appName: 'My App',
  database: './data/logon.db',
  publicBaseUrl: 'https://myapp.example.com',
  defaultLanguage: 'en',
  fields: [
    { name: 'displayName', label: 'Display name', required: true, maxLength: 60 },
    { name: 'city', label: 'City', maxLength: 80 },
  ],
  async sendMail({ to, subject, text, link, language, appName }) {
    // Send the message with your own mail provider.
    // `text` is already formatted and contains the link.
    await myMailer.send({ to, subject, text });
  },
});

app.use('/api/logon', logon.router);

app.get('/api/private', logon.requireUser, (req, res) => {
  res.json({ hello: req.logonUser.profile.displayName });
});
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `sendMail` | required | `async ({to, subject, text, link, language, appName})`. Throw to report a failed send. |
| `database` | `'logon.db'` | File path, or an open `better-sqlite3` database instance. |
| `appName` | `'App'` | Used in the mail and the page texts. |
| `fields` | `[]` | Profile fields: `{name, label, required, maxLength, pattern, inputType, autocomplete, placeholder}`. |
| `sessionDays` | `365` | Session lifetime. |
| `linkMinutes` | `30` | Magic link lifetime. |
| `cookieName` | `'logon_session'` | Name of the session cookie. |
| `publicBaseUrl` | request host | Base URL used in the magic link. **Set this in production.** |
| `defaultLanguage` | `'en'` | `'en'` or `'da'`. |
| `bindLinkToBrowser` | `false` | Only accept a magic link in the browser that requested it. Does not work with confirming on another device. See [Security](#security). |
| `requireConfirmCode` | `false` | Show a 6-digit code in the requesting browser and require it on the confirm page, also from another device. See [Security](#security). |
| `requestLinkLimit` | `{ max: 5, windowMinutes: 15 }` | Maximum `POST /request-link` calls per client IP in each window. Returns `429 rate_limited` above that. Use `false` to disable. See [Rate limiting](#rate-limiting). |
| `logger` | `console` | Pass `null` to silence logs. |

`createLogon()` returns `{ router, currentUser(req), requireUser, close() }`.

- `currentUser(req)` returns the signed-in user or `null`. The user has the shape
  `{ id, email, profile, deviceId }`, where `profile` holds your custom fields.
- `requireUser` is middleware that responds `401` when no user is signed in. On success
  it sets `req.logonUser` to the same shape. It does not touch `req.user`, so your app's
  own auth can keep using that.
- `close()` closes the database if the package opened it.

### Routes

Mounted under the path you choose (`/api/logon` above):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/config` | App name, fields, and supported languages. |
| GET | `/session` | `{ user }`, where `user` is `null` until the link is confirmed. |
| POST | `/request-link` | Body `{ email, browserId, language }`. Sends the magic link and sets the session cookie. With `requireConfirmCode`, the response also includes `confirmCode`. |
| GET | `/verify?token=` | Confirm page (HTML). Does not consume the token. |
| POST | `/verify` | Body `{ token, code }`, where `code` is only needed with `requireConfirmCode`. Confirms the link. Returns JSON when the request is JSON or accepts `application/json`, otherwise an HTML page. |
| POST | `/logout` | Ends the session. |
| PATCH | `/profile` | Updates the profile fields. Requires a signed-in user. |

### Mail contract

`sendMail` is called before anything is stored. If it throws, the API returns
`502 send_failed` and no session is created. Each new request for the same browser
retires older unused links.

### Rate limiting

`POST /request-link` is limited to 5 calls per client IP every 15 minutes by default.
Calls above the limit return `429` with `rate_limited`, and no mail is sent. Change the
limit with `requestLinkLimit`, or pass `false` to disable it:

```js
createLogon({ sendMail, requestLinkLimit: { max: 10, windowMinutes: 5 } });
```

The counters are kept in memory per process. With several server instances, each instance
counts separately, so use a shared limiter at your proxy or gateway if you need a strict
global limit. Behind a reverse proxy, set `app.set('trust proxy', 1)` so the limit applies
per client and not per proxy address.

## Security

Login works like a magic link: anyone who can open the link signs in the browser that
requested it, and the link is single-use and expires after `linkMinutes`.

**Default behaviour (`bindLinkToBrowser: false`).** The link can be opened in any browser,
and that browser is then signed in. The requesting browser is signed in too, because it
holds the session cookie. This makes it easy to confirm on a phone and keep working on a
laptop, but it carries a risk:

- **Login CSRF / account mix-up.** An attacker can request a link for a victim's email
  from the attacker's own browser and send the link to the victim. If the victim clicks
  it, the attacker's browser becomes signed in as the victim. Anything the victim then
  does in that browser is recorded against the victim's account.
- **Phishing.** A fake login page can ask for the link to be opened in the victim's browser.

**Opt-in protection (`bindLinkToBrowser: true`).** The link is only accepted in the browser
whose session cookie requested it. Opening it elsewhere returns `400 link_other_browser`,
does not use up the link, and shows a message asking the user to open it in the original
browser. The cost is that the user cannot request a link on one device and confirm it on
another, so this option does not work with confirming on a phone.

**Opt-in code protection (`requireConfirmCode: true`).** The requesting browser receives a
6-digit code in the `/request-link` response, and the code is never put in the e-mail. The
confirm page asks for the code, so the link only signs in when the person who requested it
can read the code from their screen. This works when the link is opened on another device,
such as a phone, because the user types the code in. A wrong code returns
`400 link_code_invalid` and does not use up the link. After five wrong codes the link stops
working. The code is stored only as a hash, bound to the link token.

The code does not stop phishing. If a fake page asks the victim for the code, the victim can
still be tricked into typing it.

Enable one of the options in your app if your application holds sensitive data:

```js
createLogon({ sendMail, bindLinkToBrowser: true /* ... */ });
// or, to keep phone confirmation working:
createLogon({ sendMail, requireConfirmCode: true /* ... */ });
```

The options can be combined. `bindLinkToBrowser` is incompatible with phone confirmation, so
do not combine it with a flow that expects the link to be opened on another device.

The demo keeps the defaults (`false`). Set `BIND_LINK_TO_BROWSER=true` or
`REQUIRE_CONFIRM_CODE=true` to enable them. Any other value means off. The system owner
decides the trade-off.

Also keep in mind:

- The session cookie is `httpOnly` and `sameSite=lax`. It is `secure` when
  `publicBaseUrl` is `https` or the request is HTTPS. Set `publicBaseUrl` in production.
- A session lasts up to `sessionDays` (365 by default) from sign-in. There is no
  inactivity timeout, so shorten `sessionDays` if that is required.
- Rate limiting on `/request-link` is on by default (see [Rate limiting](#rate-limiting)).

## Browser

```js
import { mountLogon } from 'logon_no_password/client';
// With a bundler, import the stylesheet. Without one, link it in your HTML.
import 'logon_no_password/styles.css';

const logon = mountLogon({
  baseUrl: '/api/logon',
  allowGuest: true,
  trigger: '#login-button',
  onChange: ({ user, guest }) => {
    console.log('signed in as', user?.email, 'guest:', guest);
  },
});
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `'/api/logon'` | Where the server router is mounted. |
| `allowGuest` | `true` | Shows a "continue as guest" option. |
| `language` | browser language, then `'en'` | Used until the user picks a language. The user's choice is stored in localStorage. |
| `messages` | `{}` | Overrides for any text, per language (deep-merged). |
| `onChange` | no-op | Called with `{ user, guest }` when the state changes. |
| `trigger` | none | Element or selector that opens the dialog when clicked. |
| `pollMs` | `4000` | How often to check whether the link was confirmed. |
| `pollMinutes` | `30` | How long to keep polling after the link was sent. |

`mountLogon()` returns `{ open, close, refresh, signOut, getUser, isGuest, ready, destroy }`.

Guest mode is only a flag stored in localStorage (`logon.guest`). It does not create a
server session. Use `requireUser` on the server for anything that must be protected.

## Development

```bash
npm install
npm test        # runs test/server.test.js
npm run demo    # starts example/server.js
```

## License

MIT
