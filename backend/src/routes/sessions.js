// Workspace sessions: one consistent "Start new session" for Education, Approx Code and Approx Work.
// A session is a project with a purpose; its conversations are ordinary chats inside that project, so history,
// sharing and deletion work unchanged. Education sessions are grounded in the uploaded document: the file is moved
// into the session's project and engine.js retrieves passages from it on every turn (see projectContext).
import { one, all, run, now } from '../db.js';
import { readJson, sendJson, bad, notFound, newId, HttpError, oneOf } from '../http.js';
import { requireUser, rateLimit } from '../security.js';

export const PURPOSES = ['education', 'code', 'work'];

const INSTRUCTIONS = {
  education: (file) => `You are Approx's teacher for the study material "${file}". The material is the source of truth:
- Base explanations, summaries, questions, tests, MCQs and answers on the study-material passages provided below. Do not invent facts, chapters or questions that are not in it; if the material does not cover something, say so and then, clearly labelled, add general knowledge only if it helps.
- "Teach / explain like a teacher": go step by step, from simple to detailed, with short examples and a quick check question at the end.
- Tests, exams and MCQs: number the questions, give 4 options (A–D) for MCQs, mark the difficulty, and finish with an answer key that names the section or topic of the material each answer comes from.
- Summaries and revision notes: headings and bullet points, key terms in bold, formulas kept exact.
- Study plans: split the material into sessions with goals and a short self-test for each.
- Reply in the language the student writes in (English, اردو or Roman Urdu).`,
  code: () => `This is an Approx Code session: a focused coding workspace. Write complete, runnable code with the file name above each block, explain briefly, prefer clear and secure solutions, and ask one short question when the requirements are ambiguous.`,
  work: () => `This is an Approx Work session: a focused workspace for documents, plans, research and analysis. Produce well-structured deliverables (headings, lists, tables where useful), keep the user's goal in view across the session, and summarise next steps at the end of longer answers.`,
};
const TITLES = { education: 'Study', code: 'Code session', work: 'Work session' };

async function sessionView(p) {
  const chat = await one('SELECT id, title, updated_at FROM chats WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1', p.id, p.user_id);
  const files = await all('SELECT id, filename, size, extracted_text IS NOT NULL AS has_text FROM files WHERE project_id = ? AND user_id = ? ORDER BY created_at', p.id, p.user_id);
  return { id: p.id, purpose: p.purpose, name: p.name, created_at: p.created_at, updated_at: p.updated_at,
    chat: chat ? { id: chat.id, title: chat.title, updated_at: chat.updated_at } : null,
    files: files.map((f) => ({ id: f.id, filename: f.filename, size: f.size, has_text: !!f.has_text })) };
}

export function registerSessionRoutes(r) {
  // GET /api/sessions?purpose=education|code|work → the person's sessions, newest first.
  r.get('/api/sessions', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const url = new URL(req.url, 'http://x');
    const purpose = oneOf(url.searchParams.get('purpose') || undefined, 'purpose', PURPOSES, null);
    const rows = purpose
      ? await all('SELECT * FROM projects WHERE user_id = ? AND purpose = ? ORDER BY updated_at DESC LIMIT 50', u.id, purpose)
      : await all('SELECT * FROM projects WHERE user_id = ? AND purpose IS NOT NULL ORDER BY updated_at DESC LIMIT 50', u.id);
    sendJson(res, 200, { sessions: await Promise.all(rows.map(sessionView)) });
  });

  // POST /api/sessions { purpose, file_id? (required for education), name? } → a clean new session (project).
  // The client then opens a conversation in it with POST /api/chats { project_id }.
  r.post('/api/sessions', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`sessions:${u.id}`, 60, 3600_000);
    const b = await readJson(req);
    const purpose = oneOf(b.purpose ?? '', 'purpose', PURPOSES);
    if ((await one('SELECT COUNT(*) c FROM projects WHERE user_id = ?', u.id)).c >= 300) throw bad('Session limit reached — delete old sessions first', 'session_limit');
    let file = null;
    if (purpose === 'education') {
      if (!b.file_id) throw bad('Upload a PDF (or a text file) of your study material first', 'file_required');
      file = await one('SELECT * FROM files WHERE id = ? AND user_id = ?', String(b.file_id), u.id);
      if (!file) throw notFound('File not found');
      if (file.scan_status !== 'clean') throw new HttpError(403, 'attachment_blocked', `${file.filename} did not pass the security scan`);
      if (!['pdf', 'text'].includes(file.kind)) throw bad('Education reads PDF or text files', 'unsupported_type');
      if (!file.extracted_text || file.extracted_text.trim().length < 40) {
        throw new HttpError(422, 'no_text', `Approx couldn't read any text in ${file.filename}. Scanned (photo) PDFs have no text layer — export it as a text PDF and upload again.`);
      }
    }
    const label = file ? file.filename.replace(/\.[^.]+$/, '') : new Date().toISOString().slice(0, 16).replace('T', ' ');
    const name = String(b.name || `${TITLES[purpose]} · ${label}`).slice(0, 100);
    const id = newId('prj_');
    await run('INSERT INTO projects (id,user_id,name,description,instructions,kind,purpose,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, u.id, name, '', INSTRUCTIONS[purpose](file?.filename), purpose === 'code' ? 'fabbox' : 'knowledge', purpose, now(), now());
    if (file) await run('UPDATE files SET project_id = ? WHERE id = ? AND user_id = ?', id, file.id, u.id);
    const p = await one('SELECT * FROM projects WHERE id = ?', id);
    sendJson(res, 201, { session: await sessionView(p), document: file ? { filename: file.filename, characters: file.extracted_text.length } : null });
  });
}
