// Outbound mail. 'outbox' stores messages in the database (development / until a provider is
// configured). 'http' posts JSON to a transactional mail provider configured via env vars.
import { run, now } from './db.js';
import { newId } from './http.js';
import { config } from './config.js';

export async function sendMail(to, subject, body) {
  const id = newId('mail_');
  let status = 'stored';
  if (config.mail.transport === 'brevo' && config.mail.httpApiKey) {
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

export function appLink(path) {
  return (config.publicUrl || `http://localhost:${config.port}`) + path;
}
