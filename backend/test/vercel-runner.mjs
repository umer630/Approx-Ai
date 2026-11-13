// Serves the Vercel function entry (api/index.js) on a local port, the way Vercel's Node runtime invokes it:
// the default export is called with a Node IncomingMessage / ServerResponse per request.
// Each scenario runs in its own process because configuration is read once, at module load.
import http from 'node:http';

const { default: fn } = await import('../../api/index.js');
const server = http.createServer((req, res) => fn(req, res));
server.listen(0, '127.0.0.1', () => console.log(`PORT ${server.address().port}`));
