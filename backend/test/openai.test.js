// GPT through the existing provider abstraction: one Approx model routed to an OpenAI-compatible API, server-side
// key, upstream model name from configuration, other models unchanged. The "OpenAI" here is a local stand-in that
// speaks the same HTTP contract (GET /v1/models, POST /v1/chat/completions with SSE) — no real key is used.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const seen = [];
const KEY = 'sk-test-' + 'x'.repeat(20);
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}'); }
  if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"gpt-4o-mini"}]}'); }
  const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  seen.push(b);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `GPT stand-in answering as ${b.model}` } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.APPROX_MODEL_HIKE_6_5_URL = `http://127.0.0.1:${srv.address().port}/v1`;
process.env.APPROX_MODEL_HIKE_6_5_NAME = 'gpt-4o-mini';
process.env.APPROX_MODEL_HIKE_6_5_KEY = KEY;
const { req, makeUser, close, parseSse } = await import('./helpers.js');
after(() => { srv.close(); close(); });

test('Hike 6.5 served by an OpenAI-compatible API: online, upstream model name + server-side key, key never exposed', async () => {
  const u = await makeUser();
  const models = await req('GET', '/api/models', { token: u.token });
  const hike = models.data.models.find((m) => m.id === 'hike-6.5');
  assert.equal(hike.status, 'online', JSON.stringify(hike));
  assert.ok(!JSON.stringify(models.data).includes(KEY), 'the key never reaches the client');
  const c = await req('POST', '/api/chats', { token: u.token, body: { model: 'hike-6.5' } });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'hello', model: 'hike-6.5' } });
  const ev = parseSse(r.data);
  assert.ok(ev.some((e) => e.event === 'delta' && /GPT stand-in answering as gpt-4o-mini/.test(e.data.text)), JSON.stringify(ev.slice(0, 3)));
  assert.equal(seen.at(-1).model, 'gpt-4o-mini');
  assert.equal(seen.at(-1).stream, true);
  assert.equal(seen.at(-1).messages[0].role, 'system', 'Approx system prompt (identity, settings, session context) is kept');
  // Other models keep their own routing (here: the development simulator), not GPT.
  const n = await req('POST', '/api/chats', { token: u.token, body: { model: 'nick-4.8' } });
  const nr = parseSse((await req('POST', `/api/chats/${n.data.chat.id}/messages`, { token: u.token, body: { content: 'hi', model: 'nick-4.8' } })).data);
  assert.ok(nr.some((e) => e.event === 'delta' && /Development simulator/.test(e.data.text)));
  assert.equal(seen.length, 1, 'Nick did not go to the GPT upstream');
});

test('a wrong or missing key makes the model offline (never selectable), not a silent failure', async () => {
  process.env.APPROX_MODEL_HIKE_6_5_KEY = 'sk-wrong';
  await new Promise((r) => setTimeout(r, 10_200));   // health is cached 10 s
  const u = await makeUser();
  const hike = (await req('GET', '/api/models', { token: u.token })).data.models.find((m) => m.id === 'hike-6.5');
  assert.equal(hike.status, 'offline');
  assert.equal(hike.selectable, false);
  process.env.APPROX_MODEL_HIKE_6_5_KEY = KEY;
});
