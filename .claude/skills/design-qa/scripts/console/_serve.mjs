#!/usr/bin/env node
/**
 * Dev-only static server for the standalone Phase-2 console (NOT the runtime
 * path — Phase 4 builds the real localhost server in the daemon). Serves this
 * directory with correct ES-module MIME types, bound to localhost.
 *
 * Usage: node _serve.mjs [port]   →   open http://127.0.0.1:<port>/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 4321;
const TYPES = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(here, rel);
  if (!file.startsWith(here)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log(`console: http://127.0.0.1:${port}/`));
