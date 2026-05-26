/**
 * The console "hat" of the session server: a localhost HTTP + SSE server that
 * serves the buildless console, exposes the owned session as data, and routes
 * console edits through the SAME SessionStore that the browser capture writes.
 *
 * Bound to 127.0.0.1 only (never 0.0.0.0). One per-session process is the sole
 * writer of its session.json; this server is that writer's network face.
 *
 * Routes:
 *   GET  /                     → console index.html (static assets from consoleDir)
 *   GET  /<asset>              → static console asset (path-traversal guarded)
 *   GET  /screenshots/<file>   → screenshot PNGs from the session dir
 *   GET  /api/session          → the owned session document
 *   GET  /api/sessions         → read-only summary of every session in the dir
 *   POST /api/mutate           → {op,args} → allowlisted console mutation
 *   GET  /api/events           → SSE; emits `change` on every store.persist()
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sessionSubPaths } from './paths.mjs';

const MIME = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// op name (matches the HttpStore method) → SessionStore method.
const CONSOLE_OPS = {
  createPin: 'createPinPct',
  movePin: 'movePinPct',
  updatePin: 'editPin',
  resolvePin: 'resolvePin',
  deletePin: 'deletePin',
};

export async function startHttpServer(store, { sessionDir, consoleDir, log = () => {} }) {
  const subs = sessionSubPaths(sessionDir);
  const sseClients = new Set();

  // Single subscription to the store: every persist() (browser OR console)
  // fans out to all connected console tabs so they live-refresh.
  store.subscribe((seq) => {
    const frame = `event: change\ndata: ${JSON.stringify({ seq })}\n\n`;
    for (const res of [...sseClients]) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  });

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function serveStatic(res, baseDir, rel) {
    const file = path.join(baseDir, rel);
    if (!file.startsWith(baseDir + path.sep) && file !== baseDir) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  }

  async function listSessions() {
    const root = path.dirname(sessionDir);
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(root, ent.name);
      const s = sessionSubPaths(dir);
      let doc;
      try { doc = JSON.parse(await fsp.readFile(s.sessionJson, 'utf8')); }
      catch { continue; }
      let live = false;
      try {
        const pid = parseInt((await fsp.readFile(s.pidFile, 'utf8')).trim(), 10);
        if (pid) { try { process.kill(pid, 0); live = true; } catch {} }
      } catch {}
      let consoleUrl = null;
      if (live) { try { consoleUrl = (await fsp.readFile(s.consoleUrlFile, 'utf8')).trim() || null; } catch {} }
      const views = doc.views || [];
      const pins = views.flatMap((v) => v.pins || []);
      const sources = { browser: 0, manual: 0 };
      for (const v of views) sources[v.source === 'manual' ? 'manual' : 'browser']++;
      out.push({
        sessionDir: dir,
        name: doc.name,
        id: doc.id,
        createdAt: doc.createdAt,
        endedAt: doc.endedAt,
        viewCount: views.length,
        pinCount: pins.length,
        unresolved: pins.filter((p) => p.status !== 'resolved').length,
        sources,
        live,
        consoleUrl,
        current: dir === sessionDir,
      });
    }
    out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return out;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let buf = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        buf += c;
        if (buf.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); }
      });
      req.on('end', () => resolve(buf));
      req.on('error', reject);
    });
  }

  async function handleMutate(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
    const { op, args = {} } = body || {};
    const method = CONSOLE_OPS[op];
    if (!method) return sendJson(res, 400, { ok: false, error: `unknown op ${op}` });

    // Live-screen ownership: the console may not edit an unsealed browser view.
    const view = op === 'createPin'
      ? store.findViewById(args.viewId)
      : store.findPin(args.pinId).view;
    try {
      if (view) store._assertConsoleEditable(view);
      const result = await store[method](args);
      return sendJson(res, 200, { ok: true, result, session: store.doc });
    } catch (err) {
      return sendJson(res, 409, { ok: false, error: String(err?.message || err) });
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: change\ndata: ${JSON.stringify({ seq: store._seq })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);

      if (req.method === 'POST' && url === '/api/mutate') return void handleMutate(req, res);
      if (req.method === 'GET' && url === '/api/session') return void sendJson(res, 200, store.doc);
      if (req.method === 'GET' && url === '/api/sessions') return void sendJson(res, 200, await listSessions());
      if (req.method === 'GET' && url === '/api/events') return void handleEvents(req, res);

      if (req.method === 'GET' && url.startsWith('/screenshots/')) {
        return void serveStatic(res, subs.screenshotsDir, url.slice('/screenshots/'.length).replace(/^\/+/, ''));
      }
      if (req.method === 'GET') {
        const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
        return void serveStatic(res, consoleDir, rel);
      }
      res.writeHead(405).end('method not allowed');
    } catch (err) {
      try { sendJson(res, 500, { ok: false, error: String(err?.message || err) }); } catch {}
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const consoleUrl = `http://127.0.0.1:${port}/`;
  log(`console serving at ${consoleUrl}`);

  return {
    consoleUrl,
    port,
    close() {
      for (const res of [...sseClients]) { try { res.end(); } catch {} }
      sseClients.clear();
      try { server.close(); } catch {}
    },
  };
}
