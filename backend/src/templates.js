// COEPROX scaffolding templates (deterministic — no model required).
export const TEMPLATES = {
  'node-api': {
    name: 'Node.js REST API',
    description: 'Dependency-free Node 22 HTTP API with a health check and a test.',
    files: {
      'package.json': '{\n  "name": "{{name}}",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "start": "node src/server.js", "test": "node --test test/" }\n}\n',
      'src/server.js': "import http from 'node:http';\n\nexport const server = http.createServer((req, res) => {\n  if (req.url === '/health') {\n    res.writeHead(200, { 'Content-Type': 'application/json' });\n    return res.end(JSON.stringify({ ok: true }));\n  }\n  res.writeHead(404).end();\n});\n\nif (process.argv[1].endsWith('server.js')) server.listen(process.env.PORT || 3000);\n",
      'test/health.test.js': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { server } from '../src/server.js';\n\ntest('health', async () => {\n  await new Promise((r) => server.listen(0, r));\n  const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);\n  assert.equal(res.status, 200);\n  server.close();\n});\n",
      'README.md': '# {{name}}\n\nScaffolded by Approx COEPROX.\n\n```\nnpm start\nnpm test\n```\n',
    },
  },
  'static-web': {
    name: 'Static web app',
    description: 'Accessible, mobile-first HTML/CSS/JS starter.',
    files: {
      'index.html': '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{name}}</title><link rel="stylesheet" href="styles.css"></head>\n<body><main><h1>{{name}}</h1><button id="btn">Click</button><p id="out"></p></main><script src="app.js"></script></body>\n</html>\n',
      'styles.css': 'body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#0b1220;color:#fff}button{padding:10px 16px;border-radius:10px;border:0;background:#22c55e;color:#04121f}\n',
      'app.js': "document.getElementById('btn').addEventListener('click', () => {\n  document.getElementById('out').textContent = 'Hello from {{name}}';\n});\n",
    },
  },
  'python-cli': {
    name: 'Python CLI',
    description: 'Python 3 command-line tool with argparse and unittest.',
    files: {
      'app.py': 'import argparse\n\n\ndef greet(name: str) -> str:\n    return f"Salam, {name}!"\n\n\nif __name__ == "__main__":\n    p = argparse.ArgumentParser(description="{{name}}")\n    p.add_argument("name")\n    print(greet(p.parse_args().name))\n',
      'test_app.py': 'import unittest\nfrom app import greet\n\n\nclass T(unittest.TestCase):\n    def test_greet(self):\n        self.assertEqual(greet("Ali"), "Salam, Ali!")\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
    },
  },
};
