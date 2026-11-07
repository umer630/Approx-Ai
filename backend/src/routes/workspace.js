// Approx Workspace (artifacts with version history), Approx Research,
// Approx FABBOX Code and COEPROX (virtual code workspaces with approval-gated agent edits).
import { one, all, run, now, tx, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, forbidden, newId, str, oneOf, HttpError, clientIp } from '../http.js';
import { requireUser, requireVerified, rateLimit } from '../security.js';
import { complete } from '../engine.js';
import { safeFetchText, htmlToText } from '../netguard.js';
import { config } from '../config.js';
import { TEMPLATES } from '../templates.js';

const EXT = { document: 'md', markdown: 'md', code: 'txt', table: 'csv', json: 'json', html: 'html' };
const LANG_EXT = { python: 'py', javascript: 'js', typescript: 'ts', java: 'java', kotlin: 'kt', go: 'go', rust: 'rs', sql: 'sql', bash: 'sh', html: 'html', css: 'css', json: 'json' };

async function collect(fn) { let text = ''; const r = await fn((d) => { text += d; }); return { ...r, text: r.text ?? text }; }

export function registerWorkspaceRoutes(r) {
  // ================= Approx Workspace =================
  const ownArtifact = (uid, id) => { const a = one('SELECT * FROM artifacts WHERE id = ? AND user_id = ?', id, uid); if (!a) throw notFound('Artifact not found'); return a; };
  const view = (a) => ({ ...a, user_id: undefined, content: one('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?', a.id, a.current_version)?.content });

  r.get('/api/workspace/artifacts', async (req, res, ctx) => {
    const u = requireUser(ctx);
    sendJson(res, 200, { artifacts: all('SELECT id, title, kind, language, current_version, project_id, chat_id, updated_at FROM artifacts WHERE user_id = ? ORDER BY updated_at DESC', u.id) });
  });
  r.post('/api/workspace/artifacts', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(req, 2 * 1024 * 1024);
    const id = newId('art_');
    const content = typeof b.content === 'string' ? b.content : '';
    if (content.length > 1_000_000) throw bad('Artifact too large');
    tx(() => {
      run('INSERT INTO artifacts (id,user_id,project_id,chat_id,title,kind,language,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, u.id, null, b.chat_id ? String(b.chat_id).slice(0, 40) : null, str(b.title, 'title', { min: 1, max: 150 }),
        oneOf(b.kind, 'kind', Object.keys(EXT), 'document'), str(b.language, 'language', { max: 30, required: false }) || '', now(), now());
      run('INSERT INTO artifact_versions (artifact_id,version,content,note,created_at) VALUES (?,?,?,?,?)', id, 1, content, 'created', now());
    });
    sendJson(res, 201, { artifact: view(ownArtifact(u.id, id)) });
  });
  r.get('/api/workspace/artifacts/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const a = ownArtifact(u.id, p.id);
    sendJson(res, 200, { artifact: view(a), versions: all('SELECT version, note, created_at, length(content) size FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC', a.id) });
  });
  r.put('/api/workspace/artifacts/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const a = ownArtifact(u.id, p.id);
    const b = await readJson(req, 2 * 1024 * 1024);
    if (typeof b.content !== 'string' || b.content.length > 1_000_000) throw bad('content must be a string up to 1,000,000 chars');
    const v = a.current_version + 1;
    tx(() => {
      run('INSERT INTO artifact_versions (artifact_id,version,content,note,created_at) VALUES (?,?,?,?,?)', a.id, v, b.content, str(b.note, 'note', { max: 200, required: false }) || 'edited', now());
      run('UPDATE artifacts SET current_version = ?, updated_at = ?, title = ? WHERE id = ?', v, now(), b.title ? str(b.title, 'title', { min: 1, max: 150 }) : a.title, a.id);
    });
    sendJson(res, 200, { artifact: view(ownArtifact(u.id, a.id)) });
  });
  r.get('/api/workspace/artifacts/:id/versions/:v', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const a = ownArtifact(u.id, p.id);
    const row = one('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?', a.id, Number(p.v));
    if (!row) throw notFound('Version not found');
    sendJson(res, 200, { version: row });
  });
  r.post('/api/workspace/artifacts/:id/restore/:v', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const a = ownArtifact(u.id, p.id);
    const row = one('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?', a.id, Number(p.v));
    if (!row) throw notFound('Version not found');
    const v = a.current_version + 1;
    run('INSERT INTO artifact_versions (artifact_id,version,content,note,created_at) VALUES (?,?,?,?,?)', a.id, v, row.content, `restored v${p.v}`, now());
    run('UPDATE artifacts SET current_version = ?, updated_at = ? WHERE id = ?', v, now(), a.id);
    sendJson(res, 200, { artifact: view(ownArtifact(u.id, a.id)) });
  });
  r.get('/api/workspace/artifacts/:id/export', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const a = view(ownArtifact(u.id, p.id));
    const ext = a.kind === 'code' ? (LANG_EXT[a.language] || 'txt') : EXT[a.kind];
    const name = a.title.replace(/[^\p{L}\p{N}_ -]/gu, '_').slice(0, 80) + '.' + ext;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(a.content);
  });
  r.delete('/api/workspace/artifacts/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    ownArtifact(u.id, p.id);
    run('DELETE FROM artifacts WHERE id = ? AND user_id = ?', p.id, u.id);
    sendJson(res, 200, { status: 'deleted' });
  });

  // ================= Approx Research =================
  r.get('/api/research/capabilities', async (req, res, ctx) => {
    requireUser(ctx);
    sendJson(res, 200, {
      url_sources: 'available',
      web_search: config.search.endpoint ? 'available' : 'unavailable: no search provider configured (set SEARCH_API_ENDPOINT/SEARCH_API_KEY)',
      knowledge_separation: 'Retrieved sources are used at answer time only and are never written into model weights.',
    });
  });

  r.post('/api/research', async (req, res, ctx) => {
    const u = requireUser(ctx);
    requireVerified(u);
    rateLimit(`research:${u.id}`, 10, 600_000);
    const b = await readJson(req);
    const query = str(b.query, 'query', { min: 3, max: 2000 });
    let urls = Array.isArray(b.urls) ? b.urls.filter((x) => typeof x === 'string').slice(0, 6) : [];
    if (!urls.length && config.search.endpoint) {
      const sr = await fetch(`${config.search.endpoint}?q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${config.search.apiKey}` }, signal: AbortSignal.timeout(10_000) }).then((x) => x.json()).catch(() => null);
      urls = (sr?.results || []).map((x) => x.url).filter(Boolean).slice(0, 6);
    }
    if (!urls.length) throw new HttpError(503, 'search_unavailable', 'No web search provider is configured. Provide source URLs in "urls" to research them.');
    const sources = [];
    const failed = [];
    await Promise.all(urls.map(async (url, i) => {
      try {
        const page = await safeFetchText(url);
        const { title, text } = page.contentType.includes('html') ? htmlToText(page.body) : { title: url, text: page.body };
        if (text.length < 80) throw new Error('Too little readable text');
        sources.push({ n: i + 1, url: page.url, title: title || page.url, excerpt: text.slice(0, 6000), retrieved_at: new Date().toISOString() });
      } catch (e) { failed.push({ url, error: e.message }); }
    }));
    sources.sort((a, x) => a.n - x.n);
    if (!sources.length) throw new HttpError(422, 'no_sources', 'None of the sources could be retrieved', { failed });
    const srcBlock = sources.map((s) => `[${s.n}] ${s.title} — ${s.url}\n${s.excerpt}`).join('\n\n');
    const out = await collect((onDelta) => complete({
      user: u, chat: null, text: `Research question: ${query}\n\nWrite a structured research report: summary, key findings, comparison where relevant, and limitations. Cite sources inline as [n]. Only use claims supported by the sources; say when sources disagree or are insufficient.`,
      requestedModel: b.model || 'auto', requestedMode: b.mode || 'high', source: 'research', requestId: ctx.requestId, onDelta, history: [], skipMemoryCapture: true,
      systemExtra: `CURRENT RETRIEVED SOURCES (retrieval knowledge, not training knowledge):\n${srcBlock}`,
    }));
    sendJson(res, 200, { query, model_id: out.route.model.id, mode: out.route.mode, report: out.text, sources: sources.map(({ excerpt, ...s }) => s), failed, knowledge_type: 'retrieval' });
  });

  // ================= FABBOX Code / COEPROX =================
  const ownCodeProject = (uid, id) => {
    const p = one("SELECT * FROM projects WHERE id = ? AND user_id = ? AND kind IN ('fabbox','coeprox')", id, uid);
    if (!p) throw notFound('Code project not found');
    return p;
  };
  const cleanPath = (pth) => {
    const s = str(pth, 'path', { min: 1, max: 200 }).replace(/\\/g, '/');
    if (s.startsWith('/') || s.split('/').some((seg) => seg === '..' || seg === '' || seg === '.') || /[\0<>:"|?*]/.test(s)) throw bad(`Invalid path: ${s}`);
    return s;
  };
  const writeFile = (proj, uid, path, content) => {
    if (typeof content !== 'string' || content.length > 300_000) throw bad(`File too large: ${path}`);
    const count = one('SELECT COUNT(*) c FROM code_files WHERE project_id = ?', proj.id).c;
    if (count >= 300 && !one('SELECT 1 FROM code_files WHERE project_id = ? AND path = ?', proj.id, path)) throw bad('File limit (300) reached');
    run('INSERT INTO code_files (project_id,user_id,path,content,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at', proj.id, uid, path, content, now());
  };

  r.get('/api/fabbox/capabilities', async (req, res, ctx) => {
    requireUser(ctx);
    sendJson(res, 200, {
      repository_files: 'available (virtual workspace: create/read/edit/delete files)',
      agent_edits: 'available (model proposes changes; you approve before they are applied)',
      code_review_and_security_review: 'available via agent instructions',
      scaffolding: 'available (COEPROX templates)',
      export_zip: 'unavailable: not implemented in v1.0 — export individual files',
      command_execution: 'unavailable: requires an isolated sandbox runner (not configured). No commands run on the Approx server.',
      tests: 'unavailable: depends on command execution sandbox',
      git_github: 'unavailable: requires a GitHub App installation with per-user OAuth (not configured)',
      ci_cd_deploy: 'unavailable: requires CI provider credentials (not configured)',
    });
  });

  r.get('/api/fabbox/:pid/files', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const proj = ownCodeProject(u.id, p.pid);
    sendJson(res, 200, { project: { id: proj.id, name: proj.name, kind: proj.kind }, files: all('SELECT path, length(content) size, updated_at FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path', proj.id, u.id) });
  });
  r.get('/api/fabbox/:pid/file', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const proj = ownCodeProject(u.id, p.pid);
    const f = one('SELECT path, content, updated_at FROM code_files WHERE project_id = ? AND user_id = ? AND path = ?', proj.id, u.id, cleanPath(url.searchParams.get('path')));
    if (!f) throw notFound('File not found');
    sendJson(res, 200, { file: f });
  });
  r.put('/api/fabbox/:pid/file', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const proj = ownCodeProject(u.id, p.pid);
    const b = await readJson(req, 1024 * 1024);
    writeFile(proj, u.id, cleanPath(b.path), b.content);
    sendJson(res, 200, { status: 'saved' });
  });
  r.delete('/api/fabbox/:pid/file', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const proj = ownCodeProject(u.id, p.pid);
    run('DELETE FROM code_files WHERE project_id = ? AND user_id = ? AND path = ?', proj.id, u.id, cleanPath(url.searchParams.get('path')));
    sendJson(res, 200, { status: 'deleted' });
  });

  r.get('/api/coeprox/templates', async (req, res, ctx) => {
    requireUser(ctx);
    sendJson(res, 200, { templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, description: t.description, files: Object.keys(t.files) })) });
  });
  r.post('/api/coeprox/:pid/scaffold', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const proj = ownCodeProject(u.id, p.pid);
    const b = await readJson(req);
    const t = TEMPLATES[b.template];
    if (!t) throw bad('Unknown template');
    tx(() => { for (const [path, content] of Object.entries(t.files)) writeFile(proj, u.id, path, content.replaceAll('{{name}}', proj.name)); });
    sendJson(res, 200, { status: 'scaffolded', files: Object.keys(t.files) });
  });

  // Agent: model proposes a change set as JSON; nothing is written until the user approves.
  r.post('/api/fabbox/:pid/agent', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    const proj = ownCodeProject(u.id, p.pid);
    const b = await readJson(req);
    const instruction = str(b.instruction, 'instruction', { min: 3, max: 8000 });
    const files = all('SELECT path, content FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path', proj.id, u.id);
    let budget = 40_000;
    const tree = files.map((f) => f.path).join('\n');
    const bodies = files.map((f) => { if (budget <= 0) return ''; const c = f.content.slice(0, Math.min(budget, 8000)); budget -= c.length; return `--- ${f.path}\n${c}`; }).filter(Boolean).join('\n');
    const out = await collect((onDelta) => complete({
      user: u, chat: null, text: instruction, requestedModel: b.model || 'auto', requestedMode: b.mode || 'high', source: proj.kind, requestId: ctx.requestId, onDelta, history: [], skipMemoryCapture: true,
      systemExtra: `FABBOX_JSON_PROTOCOL. You are the ${proj.kind === 'coeprox' ? 'COEPROX software-building' : 'FABBOX Code'} agent for project "${proj.name}".\n` +
        `Respond with ONLY a JSON object: {"summary": string, "changes": [{"op": "write"|"delete", "path": string, "content"?: string}]}. ` +
        `Paths are relative. Write complete file contents. You cannot run commands. Project instructions: ${proj.instructions || '(none)'}\n\nFILE TREE:\n${tree || '(empty)'}\n\nFILES:\n${bodies}`,
    }));
    if (out.refused) return sendJson(res, 200, { refused: true, message: out.text });
    let parsed;
    try {
      const m = out.text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : out.text);
      if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.changes)) throw new Error();
    } catch { throw new HttpError(502, 'agent_bad_output', 'The model did not return a valid change proposal. Try again or rephrase.', { raw: out.text.slice(0, 2000) }); }
    const changes = parsed.changes.slice(0, 50).map((c) => ({ op: c.op === 'delete' ? 'delete' : 'write', path: cleanPath(c.path), content: c.op === 'delete' ? undefined : String(c.content ?? '') }));
    const id = newId('prp_');
    run('INSERT INTO code_proposals (id,project_id,user_id,summary,changes,created_at) VALUES (?,?,?,?,?,?)', id, proj.id, u.id, parsed.summary.slice(0, 4000), JSON.stringify(changes), now());
    sendJson(res, 201, { proposal: { id, summary: parsed.summary, changes, status: 'pending', model_id: out.route.model.id } });
  });

  r.get('/api/fabbox/:pid/proposals', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const proj = ownCodeProject(u.id, p.pid);
    sendJson(res, 200, { proposals: all('SELECT * FROM code_proposals WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50', proj.id, u.id).map((x) => ({ ...x, changes: JSON.parse(x.changes), user_id: undefined })) });
  });

  r.post('/api/fabbox/:pid/proposals/:id/:decision', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const proj = ownCodeProject(u.id, p.pid);
    if (!['approve', 'reject'].includes(p.decision)) throw notFound();
    const prop = one("SELECT * FROM code_proposals WHERE id = ? AND project_id = ? AND user_id = ? AND status = 'pending'", p.id, proj.id, u.id);
    if (!prop) throw notFound('Pending proposal not found');
    if (p.decision === 'approve') {
      tx(() => {
        for (const c of JSON.parse(prop.changes)) {
          if (c.op === 'delete') run('DELETE FROM code_files WHERE project_id = ? AND path = ?', proj.id, c.path);
          else writeFile(proj, u.id, c.path, c.content);
        }
        run("UPDATE code_proposals SET status = 'applied', decided_at = ? WHERE id = ?", now(), prop.id);
      });
      audit(u.id, u.id, 'fabbox.proposal_applied', prop.id, clientIp(req));
    } else run("UPDATE code_proposals SET status = 'rejected', decided_at = ? WHERE id = ?", now(), prop.id);
    sendJson(res, 200, { status: p.decision === 'approve' ? 'applied' : 'rejected' });
  });
}
