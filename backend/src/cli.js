// Operator CLI (run on the server, never exposed over HTTP).
//   node src/cli.js promote <email> superadmin|admin|user
//   node src/cli.js verify <email>
//   node src/cli.js grant <email> <model_id> "<reason>"
import { getDb, one, run, now, audit } from './db.js';

getDb();
const [cmd, email, arg, reason] = process.argv.slice(2);
const user = email && one('SELECT * FROM users WHERE email = ?', email.toLowerCase());
if (!user) { console.error('usage: cli.js promote|verify|grant <email> …  (user must exist)'); process.exit(1); }
if (cmd === 'promote') {
  if (!['superadmin', 'admin', 'user'].includes(arg)) { console.error('role must be superadmin|admin|user'); process.exit(1); }
  run('UPDATE users SET role = ? WHERE id = ?', arg, user.id);
} else if (cmd === 'verify') {
  run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);
} else if (cmd === 'grant') {
  run('INSERT OR REPLACE INTO model_access (user_id,model_id,granted_by,reason,created_at) VALUES (?,?,?,?,?)', user.id, arg, 'operator-cli', reason || 'operator grant', now());
} else { console.error('unknown command'); process.exit(1); }
audit(user.id, 'operator-cli', `cli.${cmd}`, arg || null, null, {});
console.log('ok');
