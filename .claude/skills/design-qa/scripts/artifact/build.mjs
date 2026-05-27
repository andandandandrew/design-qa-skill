/**
 * Builds the exported HTML artifact from a session document.
 *
 * Shared-renderer design (one editor, two outputs): instead of a second,
 * diverging renderer, the artifact REUSES the console's render modules
 * (core.mjs + ui/* + lib/*). Those module sources are inlined into the file via
 * an import map whose keys (`@dqa/...`) resolve to base64 `data:` URLs, so the
 * whole module graph loads from `file://` with no server. The session document
 * is embedded with screenshots as `data:` URLs, and an ArtifactStore (read-
 * mostly: resolve persists to LocalStorage) backs the same store interface the
 * console uses.
 *
 * The artifact is feature-parity-with-the-console for the engineer: view +
 * filter + sort + category display + RESOLVE. Add/move/delete/edit-note stay
 * designer-side in the console (gated off here via ctx.options).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, '..', 'console');

// Shared modules inlined into the artifact, relative to the console dir. Order
// is irrelevant — the import map resolves the graph — but listing leaves first
// keeps it readable.
const SHARED_MODULES = [
  'lib/dom.mjs', 'lib/coords.mjs', 'lib/events.mjs',
  'ui/sidebar.mjs', 'ui/canvas.mjs', 'ui/comments.mjs', 'ui/resizers.mjs',
  'core.mjs', 'store/artifact-store.mjs',
];

function pngDimensions(buf) {
  // PNG: 8-byte signature, 4-byte IHDR length, 4-byte "IHDR",
  // then width (BE u32) at byte 16, height (BE u32) at byte 20.
  if (buf.length < 24) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return ''; }
}

async function loadScreenshot(sessionDir, relPath) {
  if (!relPath) return null;
  const abs = path.join(sessionDir, relPath);
  try {
    const buf = await fs.readFile(abs);
    const { width, height } = pngDimensions(buf);
    return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, width, height };
  } catch (err) {
    console.warn(`artifact: could not load ${abs}:`, err.message);
    return null;
  }
}

/**
 * Read each shared module, rewrite its relative import specifiers to the
 * `@dqa/...` import-map keys (relative specifiers don't resolve from a `data:`
 * URL base, but bare specifiers go through the import map), and base64-encode
 * the result into a `data:` URL. Returns the import map's `imports` object.
 */
async function inlineModules() {
  const keyByAbs = new Map();
  for (const rel of SHARED_MODULES) keyByAbs.set(path.resolve(CONSOLE_DIR, rel), `@dqa/${rel}`);

  const imports = {};
  for (const rel of SHARED_MODULES) {
    const abs = path.resolve(CONSOLE_DIR, rel);
    const raw = await fs.readFile(abs, 'utf8');
    const rewritten = raw.replace(/\b(from|import)\s+(['"])([^'"]+)\2/g, (m, kw, q, spec) => {
      if (!spec.startsWith('.')) return m; // bare/absolute specifier — leave it
      const targetAbs = path.resolve(path.dirname(abs), spec);
      const key = keyByAbs.get(targetAbs);
      if (!key) throw new Error(`artifact: unmapped import "${spec}" in ${rel}`);
      return `${kw} ${q}${key}${q}`;
    });
    imports[`@dqa/${rel}`] = `data:text/javascript;base64,${Buffer.from(rewritten, 'utf8').toString('base64')}`;
  }
  return imports;
}

/** Build the embedded session: the real shape, but with screenshots inlined as
 *  data URLs and pins guaranteed to carry %-at-rest coords. */
async function buildEmbeddedSession(sessionDir, session) {
  const views = [];
  for (const view of session.views) {
    const shot = await loadScreenshot(sessionDir, view.screenshot);
    const vp = view.viewport || { width: shot?.width || 1440, height: shot?.height || 900 };
    const dpr = shot && vp.width ? shot.width / vp.width : 1;
    const docHeightCss = shot && dpr ? shot.height / dpr : vp.height;
    views.push({
      id: view.id,
      source: view.source || 'browser',
      url: view.url || '',
      name: view.name || view.title || view.url || '(unnamed)',
      viewport: vp,
      screenshot: shot ? shot.dataUrl : null,
      createdAt: view.createdAt,
      // Everything in the export is frozen; ensure a sealedAt so nothing reads
      // as a live/locked screen if reopened in a console-shaped renderer.
      sealedAt: view.sealedAt || session.endedAt || view.createdAt || null,
      pins: view.pins.map((p) => ({
        id: p.id,
        viewId: view.id,
        // %-at-rest is canonical (Spike B); fall back to the px→% conversion
        // for any legacy/unsealed pin that predates normalization.
        xPct: typeof p.xPct === 'number' ? p.xPct : (vp.width ? (p.x / vp.width) * 100 : 0),
        yPct: typeof p.yPct === 'number' ? p.yPct : (docHeightCss ? (p.y / docHeightCss) * 100 : 0),
        note: p.note || '',
        category: p.category || null,
        author: p.author || null,
        status: p.status || 'open',
        resolvedNote: p.resolvedNote || null,
        createdAt: p.createdAt,
      })),
    });
  }
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    views,
  };
}

export async function buildArtifact({ sessionDir, session, outPath }) {
  const embedded = await buildEmbeddedSession(sessionDir, session);
  const moduleImports = await inlineModules();
  const styles = await fs.readFile(path.join(CONSOLE_DIR, 'styles.css'), 'utf8');
  const html = renderHtml(embedded, moduleImports, styles);
  await fs.writeFile(outPath, html, 'utf8');
  return outPath;
}

function renderHtml(session, moduleImports, styles) {
  const title = `Design QA — ${escapeHtml(session.name || '')}`;
  const viewCount = session.views.length;
  const pinCount = session.views.reduce((a, v) => a + v.pins.length, 0);
  // Escape `<` so neither block can break out of its <script> element.
  const sessionJson = JSON.stringify(session).replace(/</g, '\\u003c');
  const importMap = JSON.stringify({ imports: moduleImports }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
${styles}</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <span class="session-name" id="sessionName">Design QA</span>
    <span class="sidebar-meta mono" id="sessionMeta"></span>
    <span class="spacer"></span>
    <span class="sidebar-meta mono">${fmtDate(session.createdAt)} · ${viewCount} ${viewCount === 1 ? 'screen' : 'screens'} · ${pinCount} ${pinCount === 1 ? 'pin' : 'pins'}</span>
  </header>
  <div class="body">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title">Screens</div>
        <div class="sidebar-meta" id="sidebarMeta"></div>
      </div>
      <div class="view-list" id="viewList"></div>
    </aside>

    <main class="canvas-pane">
      <div class="canvas-toolbar">
        <span class="hint" id="canvasHint">Click a pin to read it.</span>
      </div>
      <div class="canvas" id="canvas"></div>
    </main>

    <aside class="comments">
      <div class="comments-header">
        <div class="comments-title">Comments</div>
        <div class="comments-page" id="commentsPage">—</div>
      </div>
      <div class="comments-filters">
        <select class="select" id="filterStatus">
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>
        <select class="select" id="filterCategory"><option value="all">All categories</option></select>
        <select class="select" id="sortBy">
          <option value="created">Sort: created</option>
          <option value="status">Sort: status</option>
          <option value="category">Sort: category</option>
        </select>
      </div>
      <div class="comments-list" id="commentsList"></div>
    </aside>
  </div>
</div>

<script type="importmap">${importMap}</script>
<script type="application/json" id="dqa-session">${sessionJson}</script>
<script type="module">
import { createApp, wireControls } from '@dqa/core.mjs';
import { ArtifactStore } from '@dqa/store/artifact-store.mjs';
import { setupResizers } from '@dqa/ui/resizers.mjs';

try {
  const session = JSON.parse(document.getElementById('dqa-session').textContent);
  const store = new ArtifactStore(session);
  const ctx = createApp({
    store,
    mounts: {
      sidebar: document.getElementById('viewList'),
      canvas: document.getElementById('canvas'),
      comments: document.getElementById('commentsList'),
    },
    // Read-mostly: the engineer can resolve, nothing else mutates.
    options: { canResolve: true },
  });
  wireControls(ctx);
  store.subscribe(() => ctx.render());
  setupResizers(document.querySelector('.body'));
  ctx.render();
} catch (err) {
  document.body.innerHTML = '<pre style="padding:24px;color:#f0616d">Artifact failed to load:\\n' + (err && (err.stack || err)) + '</pre>';
}
</script>
</body>
</html>`;
}
