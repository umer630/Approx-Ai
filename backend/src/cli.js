// Operator CLI (run on the server, never exposed over HTTP).
//   node src/cli.js promote <email> superadmin|admin|user
//   node src/cli.js verify <email>
//   node src/cli.js grant <email> <model_id> "<reason>"
//   node src/cli.js models list
//   node src/cli.js models import <release.tar.gz | release-directory>
//   node src/cli.js models activate <model_id> <version> [--allow-non-production] [--reason "..."]
//   node src/cli.js models deactivate <model_id>
import fs from 'node:fs';
import { getDb, one, run, now, audit } from './db.js';

await getDb();
const argv = process.argv.slice(2);

async function models() {
  const reg = await import('./registry.js');
  const [, sub, a, b] = argv;
  const flag = (f) => argv.includes(f);
  const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : '');
  if (sub === 'list') {
    for (const m of (await reg.registryOverview()).models) {
      console.log(`${m.id}  active: ${m.active_version ?? '—'}${m.active_problem ? `  (PROBLEM: ${m.active_problem})` : ''}`);
      for (const v of m.versions) console.log(`   ${v.version}  status=${v.status}  production_ready=${v.production_ready}  verified=${v.verified}  activatable=${v.activatable}${v.errors.length ? `  errors: ${v.errors[0]}` : ''}`);
    }
  } else if (sub === 'import' && a) {
    const out = fs.statSync(a).isDirectory() ? await reg.importDirectory(a, { actor: 'operator-cli' }) : await reg.importArchive(a, { actor: 'operator-cli', source: 'cli' });
    console.log(JSON.stringify({ status: out.status, model_id: out.model_id, version: out.version, release_status: out.release?.status,
      production_ready: out.release?.production_ready, activatable: out.release?.activatable, blockers: out.release?.blockers }, null, 2));
  } else if (sub === 'activate' && a && b) {
    console.log(JSON.stringify(await reg.activate(a, b, { actor: 'operator-cli', allowNonProduction: flag('--allow-non-production'), reason: opt('--reason') }), null, 2));
  } else if (sub === 'deactivate' && a) {
    console.log(JSON.stringify(await reg.deactivate(a, { actor: 'operator-cli', reason: opt('--reason') }), null, 2));
  } else { console.error('usage: cli.js models list | import <path> | activate <model> <version> [--allow-non-production] | deactivate <model>'); process.exit(1); }
}

if (argv[0] === 'models') {
  try { await models(); } catch (e) { console.error(`ERROR ${e.code || ''}: ${e.message}`); if (e.extra) console.error(JSON.stringify(e.extra, null, 2)); process.exit(1); }
} else {
  const [cmd, email, arg, reason] = argv;
  const user = email && await one('SELECT * FROM users WHERE email = ?', email.toLowerCase());
  if (!user) { console.error('usage: cli.js promote|verify|grant <email> …  (user must exist)   |   cli.js models …'); process.exit(1); }
  if (cmd === 'promote') {
    if (!['superadmin', 'admin', 'user'].includes(arg)) { console.error('role must be superadmin|admin|user'); process.exit(1); }
    await run('UPDATE users SET role = ? WHERE id = ?', arg, user.id);
  } else if (cmd === 'verify') {
    await run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);
  } else if (cmd === 'grant') {
    await run('INSERT OR REPLACE INTO model_access (user_id,model_id,granted_by,reason,created_at) VALUES (?,?,?,?,?)', user.id, arg, 'operator-cli', reason || 'operator grant', now());
  } else { console.error('unknown command'); process.exit(1); }
  await audit(user.id, 'operator-cli', `cli.${cmd}`, arg || null, null, {});
  console.log('ok');
}
