// Approx AI Developer Platform — every screen reads/writes the real backend.
import { api, setCsrf } from '/js/api.js';
import { h, toast, confirmDialog, fmtTime } from '/js/ui.js';
import { esc } from '/js/md.js';

const root = document.getElementById('dev');
let user = null;
const ORIGIN = location.origin;

const PAGES = [
  ['dashboard', 'Dashboard'], ['keys', 'API Keys'], ['models', 'Models'], ['usage', 'Usage'], ['requests', 'Requests'],
  ['docs', 'Documentation'], ['security', 'Security'], ['account', 'Account'], ['settings', 'Settings'],
];

async function render() {
  const page = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  if (page === 'signup') { location.href = '/#/signup'; return; }
  if (!user) {
    try { const me = await api('/api/auth/me'); user = me.user; setCsrf(me.csrf_token); } catch { return loginView(); }
  }
  const main = h('main', { class: 'dev-main' });
  root.replaceChildren(h('nav', { class: 'dev-nav', 'aria-label': 'Developer console' },
    h('a', { class: 'brand', href: '/' }, h('img', { src: '/assets/logo-mark-64.png', alt: '' }), h('span', {}, 'Approx ', h('span', { class: 'ai' }, 'AI'), ' API')),
    PAGES.map(([k, l]) => h('a', { href: `#/${k}`, class: k === page ? 'active' : '' }, l)),
    h('a', { href: '/' }, '← Back to chat')), main);
  try { await (VIEWS[page] || VIEWS.dashboard)(main); } catch (e) { main.append(h('div', { class: 'alert error' }, e.message)); }
}
window.addEventListener('hashchange', render);

function loginView() {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const msg = h('div');
  root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('div', { class: 'logo' }, h('img', { src: '/assets/logo-mark-192.png', alt: 'Approx AI' }), h('h1', {}, 'Approx AI Developer Platform'), h('div', { class: 'muted' }, 'Sign in with your Approx AI account')),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await api('/api/auth/login', { method: 'POST', body: { email: email.value, password: pw.value } }); user = r.user; setCsrf(r.csrf_token); render(); }
      catch (err) { msg.replaceChildren(h('div', { class: 'alert error' }, err.message)); }
    } }, h('div', { class: 'field' }, h('label', {}, 'Email'), email), h('div', { class: 'field' }, h('label', {}, 'Password'), pw), msg, h('button', { class: 'btn primary block' }, 'Sign in')),
    h('div', { class: 'auth-links' }, h('a', { href: '/#/signup' }, 'Create account'), h('a', { href: '/#/forgot' }, 'Forgot password?')))));
}

const stat = (label, v, sub) => h('div', { class: 'stat' }, h('div', { class: 'muted small' }, label), h('div', { class: 'v' }, String(v)), sub ? h('div', { class: 'small muted' }, sub) : null);

const VIEWS = {
  async dashboard(m) {
    const o = await api('/api/developer/overview');
    m.append(h('h1', {}, 'Dashboard'), h('p', { class: 'muted' }, `Signed in as ${user.email}`),
      !user.email_verified ? h('div', { class: 'alert warn' }, 'Verify your email before creating API keys. ', h('a', { href: '/#/verify' }, 'Verify')) : null,
      h('div', { class: 'stats' }, stat('Active keys', o.active_keys), stat('API requests (24h)', o.requests_24h), stat('Errors (24h)', o.errors_24h),
        stat('Quota left this hour', `${o.usage.window.remaining}/${o.usage.window.limit}`, `Cycle renews ${new Date(o.usage.cycle.renews_at).toLocaleDateString()}`)),
      h('h3', {}, 'Platform versions'), h('div', { class: 'card small' }, Object.entries(o.versions).map(([k, v]) => h('div', {}, h('b', {}, k), ': ', v))),
      h('h3', {}, 'Quick start'), h('pre', { class: 'block' }, `curl ${ORIGIN}/api/v1/chat/completions \\\n  -H "Authorization: Bearer $APPROX_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"nick-4.8","mode":"low","messages":[{"role":"user","content":"Salam! Introduce yourself."}]}'`));
  },
  async keys(m) {
    const r = await api('/api/developer/keys');
    const name = h('input', { class: 'input', placeholder: 'Key name, e.g. production-server', maxlength: '60' });
    const scopes = h('div', { class: 'row' }, r.available_scopes.map((s) => h('label', { class: 'row small' }, h('input', { type: 'checkbox', value: s, checked: s !== 'usage:read' }), s)));
    const out = h('div');
    const tbl = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Name', 'Prefix', 'Scopes', 'Created', 'Last used', 'Status', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.keys.map((k) => h('tr', {}, h('td', {}, k.name), h('td', {}, h('code', {}, `${k.prefix}…`)), h('td', {}, k.scopes.join(', ')), h('td', {}, fmtTime(k.created_at)), h('td', {}, k.last_used_at ? fmtTime(k.last_used_at) : '—'),
        h('td', {}, k.revoked_at ? h('span', { class: 'badge' }, 'revoked') : h('span', { class: 'badge green' }, 'active')),
        h('td', {}, k.revoked_at ? null : h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => { if (await confirmDialog('Rotate key?', 'A new secret is issued and the old key stops working immediately.', 'Rotate')) { const n = await api(`/api/developer/keys/${k.id}/rotate`, { method: 'POST' }); showSecret(out, n.secret); } } }, 'Rotate'),
          h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Revoke key?', 'Applications using it will stop working.', 'Revoke', true)) { await api(`/api/developer/keys/${k.id}`, { method: 'DELETE' }); render(); } } }, 'Revoke')))))));
    m.append(h('h1', {}, 'API Keys'), h('p', { class: 'muted' }, 'Secrets are shown once and stored only as SHA-256 hashes. Never embed keys in mobile apps or browser code.'),
      h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', {}, 'Name'), name), scopes,
        h('button', { class: 'btn primary', onclick: async () => {
          try { const k = await api('/api/developer/keys', { method: 'POST', body: { name: name.value, scopes: [...scopes.querySelectorAll('input:checked')].map((i) => i.value) } }); showSecret(out, k.secret); }
          catch (e) { out.replaceChildren(h('div', { class: 'alert error' }, e.message)); }
        } }, 'Create key'), out),
      h('div', { class: 'table-wrap' }, tbl));
  },
  async models(m) {
    const r = await api('/api/models');
    m.append(h('h1', {}, 'Models'), h('p', { class: 'muted' }, 'Use "auto" to let the Master Router choose. Efficiency modes (low | medium | high) are a separate parameter — they are not models.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ['ID', 'Name', 'Kind', 'Tier', 'Available', 'Active version', 'Backend', 'Description'].map((t) => h('th', {}, t)))),
      h('tbody', {}, h('tr', {}, h('td', {}, h('code', {}, 'auto')), h('td', {}, 'Master Router'), h('td', {}, '—'), h('td', {}, 'router'), h('td', {}, 'yes'), h('td', {}, '—'), h('td', {}, '—'), h('td', {}, 'Routes each request to the best permitted model.')),
          r.models.map((x) => h('tr', {}, h('td', {}, h('code', {}, x.id)), h('td', {}, x.name), h('td', {}, (x.kind||'').replace('_',' ')), h('td', {}, x.tier), h('td', {}, x.available ? 'yes' : 'no'), h('td', {}, x.active_version || '—'), h('td', {}, x.backend), h('td', {}, x.description)))))));
  },
  async usage(m) {
    const u = await api('/api/usage');
    m.append(h('h1', {}, 'Usage'), h('div', { class: 'stats' },
      stat('Used this hour', `${u.window.used}/${u.window.limit}`, u.window.resets_at ? `next slot ${new Date(u.window.resets_at).toLocaleTimeString()}` : 'full quota available'),
      stat(`Cycle (${u.cycle.days} days)`, u.cycle.used, `renews ${new Date(u.cycle.renews_at).toLocaleString()}`)),
    h('p', { class: 'muted small' }, 'Quota is shared between chat, research, Fabbox and the API, and enforced server-side. 429 responses include Retry-After.'));
  },
  async requests(m) {
    const r = await api('/api/developer/requests');
    m.append(h('h1', {}, 'Requests'), r.requests.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Request ID', 'Time', 'Key', 'Endpoint', 'Model', 'Mode', 'Status', 'Latency'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.requests.map((x) => h('tr', {}, h('td', {}, h('code', {}, x.id)), h('td', {}, new Date(x.created_at).toLocaleString()), h('td', {}, x.key_name || '—'), h('td', {}, x.endpoint), h('td', {}, x.model_id || '—'), h('td', {}, x.mode || '—'),
        h('td', {}, h('span', { class: `badge ${x.status < 400 ? 'green' : ''}` }, String(x.status))), h('td', {}, `${x.latency_ms} ms`)))))) : h('p', { class: 'muted' }, 'No API requests yet.'));
  },
  async docs(m) {
    const card = (title, ...c) => h('div', { class: 'card' }, h('h3', {}, title), ...c);
    m.append(h('h1', {}, 'API Documentation'), h('p', { class: 'muted' }, `Base URL: ${ORIGIN}/api/v1 · Auth: Authorization: Bearer apx_… · All responses carry X-Request-Id.`),
      card('POST /chat/completions', h('p', { class: 'small' }, 'Body: model ("auto" | "nick-4.8" | "hike-6.5" | "sona-9.0" | "fab-100x" | "fab-500x"), mode ("low" | "medium" | "high"), messages [{role: user|assistant|system, content}], stream (bool). Scope: chat.'),
        h('pre', { class: 'block' }, `{\n  "id": "req_…", "object": "chat.completion", "model": "nick-4.8", "mode": "high",\n  "route_reason": "user-selected",\n  "choices": [{"index":0,"message":{"role":"assistant","content":"…"},"finish_reason":"stop"}],\n  "usage": {"prompt_tokens": 0, "completion_tokens": 0}\n}`),
        h('p', { class: 'small' }, 'Streaming: Server-Sent Events. event "chunk" (delta), then "done" (full object) or "error".')),
      card('GET /models', h('p', { class: 'small' }, 'Models your account can use. Scope: models:read.')),
      card('GET /usage', h('p', { class: 'small' }, 'Quota window and cycle. Scope: usage:read.')),
      card('Errors', h('pre', { class: 'block' }, '{"error": {"code": "quota_exceeded", "message": "…", "request_id": "req_…"}}'),
        h('p', { class: 'small' }, '400 invalid_request · 401 unauthorized · 403 insufficient_scope / model_access_denied / email_not_verified · 429 rate_limited / quota_exceeded (Retry-After) · 503 model_backend_unavailable')),
      card('JavaScript', h('pre', { class: 'block' }, `const r = await fetch("${ORIGIN}/api/v1/chat/completions", {\n  method: "POST",\n  headers: { Authorization: \`Bearer \${process.env.APPROX_API_KEY}\`, "Content-Type": "application/json" },\n  body: JSON.stringify({ model: "auto", mode: "low", messages: [{ role: "user", content: "Explain QLoRA." }] }),\n});\nconsole.log((await r.json()).choices[0].message.content);`)),
      card('Python', h('pre', { class: 'block' }, `import os, requests\nr = requests.post("${ORIGIN}/api/v1/chat/completions",\n    headers={"Authorization": f"Bearer {os.environ['APPROX_API_KEY']}"},\n    json={"model": "nick-4.8", "mode": "high", "messages": [{"role": "user", "content": "Kya haal hai?"}]})\nprint(r.json()["choices"][0]["message"]["content"])`)),
      card('Access rules', h('p', { class: 'small' }, 'Sona requires a Pro plan or grant. FAB requires an explicit superadmin grant, is defensive-only, and FAB traffic is never used for training. The Master Router never routes to a model you cannot access.')));
  },
  async security(m) {
    const r = await api('/api/auth/sessions');
    m.append(h('h1', {}, 'Security'),
      h('div', { class: 'card small' }, h('ul', {}, ['Keys are hashed (SHA-256) at rest; secrets are shown once.', 'Rotate keys regularly; rotation revokes the old key immediately.', 'Use the narrowest scopes possible.', 'Keep keys server-side only — never in APKs, browser code or public repos.', 'Every API call is logged with a request ID (see Requests).'].map((t) => h('li', {}, t)))),
      h('h3', {}, 'Active sessions'), h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('tbody', {}, r.sessions.map((s) => h('tr', {}, h('td', {}, s.client), h('td', {}, (s.user_agent || '').slice(0, 50)), h('td', {}, fmtTime(s.last_seen_at)), h('td', {}, s.current ? 'this session' : h('button', { class: 'btn', onclick: async () => { await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }); render(); } }, 'Revoke'))))))));
  },
  async account(m) {
    const r = await api('/api/settings');
    m.append(h('h1', {}, 'Account'), h('div', { class: 'card' }, h('div', {}, r.user.email), h('div', { class: 'small muted' }, `Plan ${r.user.plan} · ${r.user.email_verified ? 'verified' : 'unverified'} · role ${r.user.role}`)),
      h('a', { class: 'btn', href: '/#/' }, 'Manage account in Approx AI settings'),
      h('button', { class: 'btn', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); user = null; render(); } }, 'Log out'));
  },
  async settings(m) {
    const r = await api('/api/settings');
    const sel = h('select', { class: 'input' }, (await api('/api/models')).models.filter((x) => x.available).map((x) => h('option', { value: x.id, selected: r.settings.default_model === x.id }, x.name)));
    m.append(h('h1', {}, 'Settings'), h('div', { class: 'field' }, h('label', {}, 'Default model'), sel),
      h('button', { class: 'btn primary', onclick: async () => { await api('/api/settings', { method: 'PATCH', body: { default_model: sel.value } }); toast('Saved'); } }, 'Save'));
  },
};

function showSecret(out, secret) {
  out.replaceChildren(h('div', { class: 'alert ok' }, h('p', {}, 'Copy your secret now — it will not be shown again.'), h('div', { class: 'secret' }, secret),
    h('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(secret); toast('Copied'); } }, 'Copy')));
  void esc;
}

render();
