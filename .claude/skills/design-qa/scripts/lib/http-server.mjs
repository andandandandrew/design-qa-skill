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
 *   GET  /screenshots/<file>   → screenshot PNGs from the OWNED session dir
 *   GET  /sessions/<dir>/screenshots/<file>
 *                              → screenshot from any SIBLING session (Phase 6 lookback)
 *   GET  /api/session          → the owned session document
 *   GET  /api/session?id=<dir> → a sibling session's document, read-only (Phase 6)
 *   GET  /api/sessions         → read-only summary of every session in the dir
 *   POST /api/mutate[?id=<dir>]→ {op,args} → allowlisted mutation against the
 *                                 owned session (no id) or a SIBLING (id).
 *   POST /api/upload[?id=<dir>]→ image body → new source:'manual' screen on
 *                                 the owned session (no id) or a SIBLING (id).
 *   GET  /api/events           → SSE; emits `change` on every store.persist()
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sessionSubPaths } from './paths.mjs';
import { SessionStore } from './session.mjs';

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
  const sessionsRoot = path.dirname(sessionDir);
  const sseClients = new Set();
  const ownedBasename = path.basename(sessionDir);

  /**
   * Cross-session writes (post-Phase-6 redesign): the current server may also
   * write to ANY archived sibling — there's no other writer for an ended
   * session, so allowing the live process to author its edits unifies the
   * model (lookback isn't read-only anymore). We cache a SessionStore per
   * basename, lazily loaded on first targeted write. The owned store stays
   * the SSE source of truth; cross-session mutations don't broadcast (rare
   * edge case; clients refetch via the mutate response, which adopts the
   * authoritative doc).
   */
  const archivedStores = new Map(); // basename → SessionStore

  /**
   * Resolve a sibling session directory by its BASENAME, with hard guards
   * against path traversal. Returns null on miss or any rejected input. Used
   * by every cross-session read AND write endpoint.
   */
  function siblingSessionDir(basename) {
    if (!basename || typeof basename !== 'string') return null;
    if (basename.includes('/') || basename.includes('\\') || basename === '.' || basename === '..') return null;
    const dir = path.join(sessionsRoot, basename);
    if (!dir.startsWith(sessionsRoot + path.sep)) return null;
    return dir;
  }

  /**
   * Pick the SessionStore to mutate against, by `?id=` parameter. No id (or
   * the owned basename) → the live owned store. An archived basename →
   * a lazily-loaded SessionStore that's cached for subsequent writes.
   * Returns null on a malformed/missing id so the caller can 400/404.
   */
  async function resolveTargetStore(id) {
    if (!id || id === ownedBasename) return store;
    const dir = siblingSessionDir(id);
    if (!dir) return null;
    if (archivedStores.has(id)) return archivedStores.get(id);
    try {
      const s = await SessionStore.load(dir);
      archivedStores.set(id, s);
      return s;
    } catch {
      return null;
    }
  }

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
        project: doc.project ?? null,
        viewCount: views.length,
        pinCount: pins.length,
        unresolved: pins.filter((p) => p.status !== 'resolved').length,
        sources,
        live,
        consoleUrl,
        // Phase 6: ended sessions are opened read-only against the CURRENT
        // server by basename, not by spawning a server for them. Live siblings
        // keep navigating to their own server's URL.
        lookbackUrl: live ? null : `/?session=${encodeURIComponent(ent.name)}`,
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

  // Binary body (screenshot uploads). No setEncoding → chunks are Buffers.
  function readBodyBuffer(req, limit = 25_000_000) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('upload too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  // Allowed upload image types → file extension.
  const UPLOAD_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

  async function handleUpload(req, res) {
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    const name = q.get('name') || 'Uploaded screenshot';
    const width = parseInt(q.get('w'), 10) || null;
    const height = parseInt(q.get('h'), 10) || null;
    const target = await resolveTargetStore(q.get('id'));
    if (target === null) return sendJson(res, 404, { ok: false, error: 'unknown session id' });
    const mime = (req.headers['content-type'] || '').split(';')[0].trim();
    const ext = UPLOAD_EXT[mime];
    if (!ext) return sendJson(res, 415, { ok: false, error: `unsupported image type: ${mime || 'none'}` });
    let imageBuffer;
    try { imageBuffer = await readBodyBuffer(req); }
    catch (err) { return sendJson(res, 413, { ok: false, error: String(err?.message || err) }); }
    if (!imageBuffer.length) return sendJson(res, 400, { ok: false, error: 'empty upload' });
    try {
      const view = await target.addManualView({ name, ext, width, height, imageBuffer });
      return sendJson(res, 200, { ok: true, result: { viewId: view.id }, session: target.doc });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  async function handleMutate(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendJson(res, 400, { ok: false, error: 'invalid json' }); }
    const { op, args = {} } = body || {};
    const method = CONSOLE_OPS[op];
    if (!method) return sendJson(res, 400, { ok: false, error: `unknown op ${op}` });

    // The mutation may target a sibling session (?id=); fall back to owned.
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    const target = await resolveTargetStore(q.get('id'));
    if (target === null) return sendJson(res, 404, { ok: false, error: 'unknown session id' });

    // Live-screen ownership only matters for the LIVE owned session — an
    // archived session has no unsealed browser view, so the guard is a no-op
    // there. Applied via target so it follows the right doc.
    const view = op === 'createPin'
      ? target.findViewById(args.viewId)
      : target.findPin(args.pinId).view;
    try {
      if (view) target._assertConsoleEditable(view);
      const result = await target[method](args);
      return sendJson(res, 200, { ok: true, result, session: target.doc });
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
      const rawUrl = req.url || '/';
      const qIdx = rawUrl.indexOf('?');
      const url = decodeURIComponent(qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx));
      const query = qIdx === -1 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(qIdx + 1));

      if (req.method === 'POST' && url === '/api/mutate') return void handleMutate(req, res);
      if (req.method === 'POST' && url === '/api/upload') return void handleUpload(req, res);
      if (req.method === 'GET' && url === '/api/session') {
        // Phase 6: optional `?id=<basename>` returns a sibling session's doc
        // read-only. The current server stays the sole writer of its OWN
        // session; serving a sibling's bytes does not make it that session's
        // writer (mutations remain blocked by the lookback store client-side
        // AND by the absence of any sibling-mutation endpoint server-side).
        const id = query.get('id');
        if (!id) return void sendJson(res, 200, store.doc);
        const dir = siblingSessionDir(id);
        if (!dir) return void sendJson(res, 400, { ok: false, error: 'invalid session id' });
        const subj = sessionSubPaths(dir);
        let doc;
        try { doc = JSON.parse(await fsp.readFile(subj.sessionJson, 'utf8')); }
        catch (err) {
          const code = err.code === 'ENOENT' ? 404 : 500;
          return void sendJson(res, code, { ok: false, error: `session ${id}: ${err.message}` });
        }
        return void sendJson(res, 200, doc);
      }
      if (req.method === 'GET' && url === '/api/sessions') return void sendJson(res, 200, await listSessions());
      if (req.method === 'GET' && url === '/api/events') return void handleEvents(req, res);

      if (req.method === 'GET' && url.startsWith('/screenshots/')) {
        return void serveStatic(res, subs.screenshotsDir, url.slice('/screenshots/'.length).replace(/^\/+/, ''));
      }
      // Phase 6: sibling-session screenshots, addressed by session basename
      // (path-traversal guarded by siblingSessionDir + serveStatic's own
      // startsWith check inside the screenshots/ subdir).
      if (req.method === 'GET' && url.startsWith('/sessions/')) {
        const rest = url.slice('/sessions/'.length);
        const slash = rest.indexOf('/');
        const base = slash === -1 ? rest : rest.slice(0, slash);
        const tail = slash === -1 ? '' : rest.slice(slash + 1);
        const dir = siblingSessionDir(base);
        if (!dir) return void (res.writeHead(404).end('not found'));
        if (!tail.startsWith('screenshots/')) return void (res.writeHead(404).end('not found'));
        const file = tail.slice('screenshots/'.length).replace(/^\/+/, '');
        return void serveStatic(res, path.join(dir, 'screenshots'), file);
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
