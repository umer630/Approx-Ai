// Outbound mail. 'outbox' stores messages in the database (development / until a provider is
// configured). 'smtp' sends through an SMTP server (Gmail + App Password by default) with Nodemailer.
// 'http' posts JSON to a transactional mail provider; 'brevo' uses Brevo's API.
import nodemailer from 'nodemailer';
import { run, now } from './db.js';
import { newId } from './http.js';
import { config } from './config.js';

export async function sendMail(to, subject, body) {
  const id = newId('mail_');
  let status = 'stored';
  if (config.mail.transport === 'smtp') {
    status = await sendSmtp(to, subject, body);
  } else if (config.mail.transport === 'brevo' && config.mail.httpApiKey) {
    // Brevo (free plan; can send from a single verified sender address — no domain of your own needed).
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/.exec(config.mail.from) || [];
    try {
      const r = await fetch(config.mail.httpEndpoint || 'https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': config.mail.httpApiKey },
        body: JSON.stringify({ sender: { email: m[2], name: (m[1] || 'Approx AI').trim() }, to: [{ email: to }], subject, textContent: body }),
        signal: AbortSignal.timeout(10_000),
      });
      status = r.ok ? 'sent' : `failed_${r.status}`;
    } catch { status = 'failed_network'; }
  } else if (config.mail.transport === 'http' && config.mail.httpEndpoint && config.mail.httpApiKey) {
    try {
      const r = await fetch(config.mail.httpEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.mail.httpApiKey}` },
        body: JSON.stringify({ from: config.mail.from, to: [to], subject, text: body }),
        signal: AbortSignal.timeout(10_000),
      });
      status = r.ok ? 'sent' : `failed_${r.status}`;
    } catch { status = 'failed_network'; }
  }
  await run('INSERT INTO mail_outbox (id,to_email,subject,body,status,created_at) VALUES (?,?,?,?,?,?)', id, to, subject, body, status, now());
  if (config.env === 'development' && status === 'stored') console.log(`[mail:outbox] to=${to} subject="${subject}"\n${body}\n`);
  return status;
}

/** True when the selected transport has what it needs to actually deliver mail. */
export function mailConfigured() {
  const m = config.mail;
  if (m.transport === 'smtp') return !!(m.smtp.host && m.smtp.user && m.smtp.pass);
  if (m.transport === 'brevo') return !!m.httpApiKey;
  if (m.transport === 'http') return !!(m.httpEndpoint && m.httpApiKey);
  return false;
}

// One short-lived connection per message (no pool): serverless instances are frozen between requests, so a
// pooled socket would be dead on the next invocation. Timeouts keep a slow SMTP server inside the function limit.
async function sendSmtp(to, subject, body) {
  const s = config.mail.smtp;
  if (!s.user || !s.pass) {
    console.error('[mail] MAIL_TRANSPORT=smtp but MAIL_SMTP_USER/APPROX_BOOTSTRAP_SUPERADMIN_EMAIL or MAIL_SMTP_PASS is not set');
    return 'failed_not_configured';
  }
  const transporter = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  });
  try {
    await transporter.sendMail({ from: config.mail.from, to, subject, text: body });
    return 'sent';
  } catch (e) {
    // Log the SMTP code/response only — never the credentials (Nodemailer does not include them in errors).
    console.error(`[mail] SMTP send failed: ${e.code || 'error'} ${e.responseCode || ''} ${String(e.response || e.message || '').slice(0, 200)}`);
    return `failed_smtp_${e.responseCode || e.code || 'error'}`.slice(0, 40);
  } finally {
    transporter.close();
  }
}

export function appLink(path) {
  return (config.publicUrl || `http://localhost:${config.port}`) + path;
}
