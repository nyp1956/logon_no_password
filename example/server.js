import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import nodemailer from 'nodemailer';
import { createLogon } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const publicBaseUrl = `http://localhost:${port}`;

// SMTP settings come from environment variables only. Without SMTP_HOST, links are printed to the console.
const smtpPort = Number(process.env.SMTP_PORT) || 587;
const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

// BIND_LINK_TO_BROWSER=true accepts a magic link only in the browser that requested it.
const bindLinkToBrowser = process.env.BIND_LINK_TO_BROWSER === 'true';
// REQUIRE_CONFIRM_CODE=true shows a 6-digit code in the requesting browser that must be entered when confirming.
const requireConfirmCode = process.env.REQUIRE_CONFIRM_CODE === 'true';

const app = express();

const logon = createLogon({
  appName: 'Logon demo',
  database: path.join(here, 'demo.db'),
  publicBaseUrl,
  defaultLanguage: 'en',
  bindLinkToBrowser,
  requireConfirmCode,
  fields: [
    { name: 'displayName', label: 'Display name', required: true, maxLength: 60 },
    { name: 'city', label: 'City', maxLength: 80 },
  ],
  async sendMail({ to, subject, text, link }) {
    if (!transport) {
      console.log(`\n[mail] to: ${to}\n[mail] subject: ${subject}\n[mail] link: ${link}\n`);
      return;
    }
    await transport.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
  },
});

app.use('/logon/src', express.static(path.join(here, '..', 'src')));
app.use('/api/logon', logon.router);

app.get('/api/private', logon.requireUser, (req, res) => {
  const { id, email, profile } = req.logonUser;
  res.json({ message: `Hello ${profile.displayName || email}`, user: { id, email, profile } });
});

app.use(express.static(path.join(here, 'public')));

const server = app.listen(port, () => {
  console.log(
    `Logon demo running on ${publicBaseUrl} (bindLinkToBrowser: ${bindLinkToBrowser}, requireConfirmCode: ${requireConfirmCode})`,
  );
});

function shutdown() {
  server.close(() => {
    logon.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
