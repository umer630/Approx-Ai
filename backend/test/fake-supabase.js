// Test double for Supabase Auth (GoTrue) — used ONLY by the automated tests, never by the app.
// Implements the subset of the GoTrue REST API the backend calls, with the real service's semantics for a project with
// "Confirm email" ON: sign-up creates an unconfirmed user and "sends" a confirmation email; an already-registered
// address gets an obfuscated answer (no enumeration); email links redirect to redirect_to with the session in the URL
// fragment (implicit flow) or an error fragment; POST /verify accepts token hashes; errors use GoTrue's error codes.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startFakeSupabase({ publishableKey = 'sb_publishable_test_key', secretKey = 'sb_secret_test_key' } = {}) {
  const users = new Map();       // email → user
  const otps = new Map();        // token_hash → { email, kind: 'signup' | 'recovery' | 'email_change', used }
  const sessions = new Map();    // access_token → email
  const emails = [];             // what Supabase would have emailed: { to, type, token_hash, link, redirect_to }
  const calls = [];              // { method, path, query } for assertions
  let base = '';

  const rnd = (n = 24) => crypto.randomBytes(n).toString('hex');
  const pub = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, new_email: u.new_email || undefined,
    email_confirmed_at: u.confirmed_at, confirmed_at: u.confirmed_at, user_metadata: u.user_metadata,
    identities: [{ provider: 'email', identity_id: u.id }], created_at: u.created_at });
  const session = (u) => { const at = 'at_' + rnd(); sessions.set(at, u.email); return { access_token: at, token_type: 'bearer', expires_in: 3600, refresh_token: 'rt_' + rnd(8), user: pub(u) }; };
  const send = (to, kind, redirectTo) => {
    for (const o of otps.values()) if (o.email === to && o.kind === kind) o.used = true; // one live token per user & purpose
    const th = 'th_' + rnd(20);
    otps.set(th, { email: to, kind, used: false });
    const type = kind === 'signup' ? 'signup' : kind;
    const link = `${base}/auth/v1/verify?token=${th}&type=${type}&redirect_to=${encodeURIComponent(redirectTo || '')}`;
    emails.push({ to, type, token_hash: th, link, redirect_to: redirectTo });
  };
  const err = (res, status, code, msg) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: status, error_code: code, msg })); };
  const ok = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const consume = (th, types) => {
    const o = otps.get(th);
    if (!o || o.used || !types.includes(o.kind)) return null;
    o.used = true;
    return o;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {}; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { return err(res, 400, 'bad_json', 'bad json'); }
    const p = url.pathname.replace(/^\/auth\/v1/, '');
    calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body });
    const admin = p.startsWith('/admin/');
    const key = req.headers.apikey;
    if (p !== '/verify' || req.method !== 'GET') {
      if (key !== (admin ? secretKey : publishableKey) && !(admin && key === secretKey)) return err(res, 401, 'no_api_key', 'Invalid API key');
    }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const me = sessions.has(bearer) ? users.get(sessions.get(bearer)) : null;
    const redirectTo = url.searchParams.get('redirect_to') || '';

    if (req.method === 'POST' && p === '/signup') {
      const email = String(body.email || '').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(res, 400, 'email_address_invalid', 'Email address is invalid');
      if (String(body.password || '').length < 6) return err(res, 422, 'weak_password', 'Password should be at least 6 characters.');
      const ex = users.get(email);
      if (ex && ex.confirmed_at) return ok(res, { id: crypto.randomUUID(), email, identities: [], user_metadata: {} }); // obfuscated
      if (ex) { ex.password = body.password; send(email, 'signup', redirectTo); return ok(res, pub(ex)); }
      const u = { id: crypto.randomUUID(), email, password: body.password, confirmed_at: null, user_metadata: body.data || {}, created_at: new Date().toISOString() };
      users.set(email, u);
      send(email, 'signup', redirectTo);
      return ok(res, pub(u));
    }
    if (req.method === 'GET' && p === '/verify') {
      const type = url.searchParams.get('type');
      const o = consume(url.searchParams.get('token'), type === 'signup' ? ['signup'] : [type]);
      if (!o) { res.writeHead(303, { location: `${redirectTo}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` }); return res.end(); }
      const u = users.get(o.email);
      if (o.kind === 'signup') u.confirmed_at ||= new Date().toISOString();
      if (o.kind === 'email_change') { users.delete(u.email); u.email = u.new_email; u.new_email = null; users.set(u.email, u); }
      const s = session(u);
      res.writeHead(303, { location: `${redirectTo}#access_token=${s.access_token}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=${type}` });
      return res.end();
    }
    if (req.method === 'POST' && p === '/verify') {
      const kinds = { signup: ['signup'], email: ['signup'], recovery: ['recovery'], email_change: ['email_change'] }[body.type];
      const o = kinds && consume(body.token_hash, kinds);
      if (!o) return err(res, 403, 'otp_expired', 'Email link is invalid or has expired');
      const u = users.get(o.email);
      if (o.kind === 'signup') u.confirmed_at ||= new Date().toISOString();
      if (o.kind === 'email_change') { users.delete(u.email); u.email = u.new_email; u.new_email = null; users.set(u.email, u); u.confirmed_at ||= new Date().toISOString(); }
      return ok(res, session(u));
    }
    if (req.method === 'POST' && p === '/token' && url.searchParams.get('grant_type') === 'password') {
      const u = users.get(String(body.email || '').toLowerCase());
      if (!u || u.password !== body.password) return err(res, 400, 'invalid_credentials', 'Invalid login credentials');
      if (!u.confirmed_at) return err(res, 400, 'email_not_confirmed', 'Email not confirmed');
      return ok(res, session(u));
    }
    if (req.method === 'POST' && p === '/resend') {
      const u = users.get(String(body.email || '').toLowerCase());
      if (body.type === 'signup' && u && !u.confirmed_at) send(u.email, 'signup', redirectTo);
      return ok(res, {});
    }
    if (req.method === 'POST' && p === '/recover') {
      const u = users.get(String(body.email || '').toLowerCase());
      if (u) send(u.email, 'recovery', redirectTo);
      return ok(res, {});
    }
    if (p === '/user') {
      if (!me) return err(res, 403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
      if (req.method === 'GET') return ok(res, pub(me));
      if (req.method === 'PUT') {
        if (body.password) {
          if (body.password === me.password) return err(res, 422, 'same_password', 'New password should be different from the old password.');
          if (String(body.password).length < 6) return err(res, 422, 'weak_password', 'Password should be at least 6 characters.');
          me.password = body.password;
        }
        if (body.email) {
          const e = String(body.email).toLowerCase();
          if (users.has(e)) return err(res, 422, 'email_exists', 'A user with this email address has already been registered');
          me.new_email = e; send(e, 'email_change', redirectTo);
        }
        return ok(res, pub(me));
      }
    }
    if (req.method === 'POST' && p === '/logout') { sessions.delete(bearer); res.writeHead(204); return res.end(); }
    if (req.method === 'DELETE' && admin && p.startsWith('/admin/users/')) {
      const id = decodeURIComponent(p.split('/').pop());
      for (const [e, u] of users) if (u.id === id) users.delete(e);
      return ok(res, {});
    }
    return err(res, 404, 'not_found', `no route ${req.method} ${p}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  /** "Click" an email link like a browser: follow the redirect and parse the fragment Supabase put on redirect_to. */
  async function click(link) {
    const r = await fetch(link, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    const [target, frag = ''] = loc.split('#');
    return { target, params: Object.fromEntries(new URLSearchParams(frag)) };
  }
  const lastEmail = (to, type) => [...emails].reverse().find((m) => m.to === to && (!type || m.type === type));
  const confirm = (email) => { const u = users.get(email.toLowerCase()); if (u) u.confirmed_at ||= new Date().toISOString(); };
  return { url: base, publishableKey, secretKey, users, emails, calls, click, lastEmail, confirm, close: () => server.close() };
}
