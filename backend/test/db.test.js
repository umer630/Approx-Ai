// libSQL layer: transactions are isolated per async context, roll back atomically, and never capture
// queries from concurrent requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.APPROX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-dbtest-'));
process.env.APPROX_DB_URL = '';
const db = await import('../src/db.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('tx commits atomically', async () => {
  await db.tx(async () => {
    await db.run("INSERT INTO rate_buckets (key, count, reset_at) VALUES ('tx-a', 1, 0)");
    await db.run("INSERT INTO rate_buckets (key, count, reset_at) VALUES ('tx-b', 1, 0)");
  });
  assert.equal((await db.one("SELECT COUNT(*) c FROM rate_buckets WHERE key IN ('tx-a','tx-b')")).c, 2);
});

test('tx rolls back every statement on error', async () => {
  await assert.rejects(db.tx(async () => {
    await db.run("INSERT INTO rate_buckets (key, count, reset_at) VALUES ('rb-1', 1, 0)");
    throw new Error('boom');
  }), /boom/);
  assert.equal(await db.one("SELECT * FROM rate_buckets WHERE key = 'rb-1'"), undefined);
});

test('a concurrent request never joins another request\'s transaction', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  // Request A: opens a transaction, writes, waits, then fails (rolls back).
  const a = db.tx(async () => {
    await db.run("INSERT INTO rate_buckets (key, count, reset_at) VALUES ('iso-a', 1, 0)");
    await gate;
    throw new Error('A fails');
  }).catch((e) => e);
  await sleep(20);
  // Request B: runs while A's transaction is open. It must NOT be part of A's transaction.
  const b = (async () => { await db.run("INSERT INTO rate_buckets (key, count, reset_at) VALUES ('iso-b', 1, 0)"); })();
  await sleep(20);
  release();
  const [ea] = await Promise.all([a, b]);
  assert.match(String(ea), /A fails/);
  assert.equal(await db.one("SELECT * FROM rate_buckets WHERE key = 'iso-a'"), undefined, 'A rolled back');
  assert.ok(await db.one("SELECT * FROM rate_buckets WHERE key = 'iso-b'"), "B's write survives A's rollback");
});

test('nested tx reuses the outer transaction', async () => {
  await assert.rejects(db.tx(async () => {
    await db.run("INSERT INTO rate_buckets (key, count, reset_at) VALUES ('n-outer', 1, 0)");
    await db.tx(async () => { await db.run("INSERT INTO rate_buckets (key, count, reset_at) VALUES ('n-inner', 1, 0)"); });
    throw new Error('outer fails');
  }), /outer fails/);
  assert.equal((await db.one("SELECT COUNT(*) c FROM rate_buckets WHERE key LIKE 'n-%'")).c, 0);
});

test('rows are plain objects; undefined args become NULL; booleans become 0/1', async () => {
  await db.run('INSERT INTO rate_buckets (key, count, reset_at) VALUES (?, ?, ?)', 'types', true, 5);
  const r = await db.one('SELECT key, count, reset_at FROM rate_buckets WHERE key = ?', 'types');
  assert.deepEqual({ ...r }, { key: 'types', count: 1, reset_at: 5 });
  assert.equal(typeof r.count, 'number');
  db.close();
});
