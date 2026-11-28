// Updater logic without Electron: version comparison, release parsing, checksum-verified download (bad files discarded).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, download, cmpVer } = require('../updater.js');

const json = (o, status = 200) => async () => ({ ok: status === 200, status, json: async () => o });
test('version comparison', () => { assert.ok(cmpVer('1.10.0', '1.9.9') > 0); assert.equal(cmpVer('2.0.0', '2.0.0'), 0); assert.ok(cmpVer('1.7.0', '1.7.1') < 0); });
test('check: newer verified release → available; same/older/no Windows build → none; errors reported', async () => {
  const rel = { available: true, version: '1.8.0', notes: 'n', windows: { url: 'https://x/Approx.exe', sha256: 'a'.repeat(64) } };
  assert.equal((await check({ server: 's', current: '1.7.0', fetchImpl: json(rel) })).status, 'available');
  assert.equal((await check({ server: 's', current: '1.8.0', fetchImpl: json(rel) })).status, 'none');
  assert.equal((await check({ server: 's', current: '1.7.0', fetchImpl: json({ ...rel, windows: { url: 'u', sha256: null } }) })).status, 'none');
  assert.equal((await check({ server: 's', current: '1.7.0', fetchImpl: json({ available: false, reason: 'none yet' }) })).status, 'none');
  assert.equal((await check({ server: 's', current: '1.7.0', fetchImpl: json({}, 500) })).status, 'error');
});
test('download: verified file kept, tampered file deleted and never returned', async () => {
  const body = Buffer.from('MZ fake installer bytes');
  const good = crypto.createHash('sha256').update(body).digest('hex');
  const resp = () => async () => ({ ok: true, status: 200, headers: new Map([['content-length', String(body.length)]]), body: (async function* () { yield body.subarray(0, 5); yield body.subarray(5); })() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const f = await download({ url: 'u', sha256: good, version: '1.8.0', dir, fetchImpl: resp() });
  assert.equal(fs.readFileSync(f).toString(), body.toString());
  await assert.rejects(download({ url: 'u', sha256: 'b'.repeat(64), version: '1.9.0', dir, fetchImpl: resp() }), /Checksum mismatch/);
  assert.equal(fs.existsSync(path.join(dir, 'Approx-1.9.0.exe')), false); assert.equal(fs.existsSync(path.join(dir, 'Approx-1.9.0.exe.part')), false);
});
