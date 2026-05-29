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
import { timestampSlug } from '../lib/paths.mjs';
import { emitRecordingSpec } from '../lib/emit-spec.mjs';
import { emitRecordingSteps } from '../lib/emit-steps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, '..', 'console');

// Shared modules inlined into the artifact, relative to the console dir. Order
// is irrelevant — the import map resolves the graph — but listing leaves first
// keeps it readable.
const SHARED_MODULES = [
  'lib/dom.mjs', 'lib/coords.mjs', 'lib/events.mjs',
  'ui/icons.mjs', 'ui/menu.mjs',
  'ui/recorder-format.mjs', 'ui/preview-spec.mjs', 'ui/steps.mjs',
  'ui/sidebar.mjs', 'ui/canvas.mjs', 'ui/comments.mjs', 'ui/resizers.mjs', 'ui/toast.mjs',
  'core.mjs', 'store/local-resolve.mjs', 'store/artifact-store.mjs',
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
      // Recorded Playwright steps power the read-only Steps tab in the artifact.
      steps: Array.isArray(view.steps) ? view.steps : [],
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
  // DesignOS foundation is inlined ahead of app styles, same order as the
  // console's <link> chain: tokens (vars) → base (primitives) → styles (app).
  // base.css ships with relative-color pre-resolved + its font @import lifted
  // to <head>, so this concatenated <style> is valid + portable on file://.
  const styles = (await Promise.all(
    ['tokens.css', 'base.css', 'styles.css'].map((f) =>
      fs.readFile(path.join(CONSOLE_DIR, f), 'utf8')),
  )).join('\n');
  const html = renderHtml(embedded, moduleImports, styles);
  await fs.writeFile(outPath, html, 'utf8');
  return outPath;
}

/** YYYYMMDD slug (no separators) — used to scope `vN` so re-exports on the
 *  same day bump versions and a fresh day's exports start over. */
function dateSlug(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Scan the session dir for `artifact-<date>-v<N>.html` siblings and return
 *  the next free N (1 if none). Misses (ENOENT etc.) treated as empty. */
async function nextVersion(sessionDir, date) {
  const re = new RegExp(`^artifact-${date}-v(\\d+)\\.html$`);
  let entries = [];
  try { entries = await fs.readdir(sessionDir); } catch { /* empty dir */ }
  let max = 0;
  for (const name of entries) {
    const m = re.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/**
 * Higher-level export action (Phase 7, extended by Spike 8 phase 9e). Produces
 * a PAIR of outputs from one call:
 *
 *  1. A versioned self-contained file at
 *     `<sessionDir>/artifact-YYYYMMDD-vN.html`, where `N` is the next free
 *     integer for today's date. Same file shape as `buildArtifact()` — opens
 *     from `file://`, no server needed.
 *  2. A directory bundle at `<sessionDir>/exports/<YYYYMMDD-HHMMSS>-vN/`
 *     containing `artifact.html` (the same self-contained build),
 *     `session.json` (a fresh copy of the in-memory doc), `screenshots/`
 *     (every file referenced from `session.json`), the Spike-8 replay pair
 *     (`recording.spec.ts` + `recording-steps.md`, both emitted from the same
 *     `views[].steps[]` the console shows), and a README.
 *
 * The on-the-fly `zip` in `http-server.mjs::handleExport` archives the bundle
 * dir's contents wholesale, so the two new files ride along with no server
 * change. The single-file Share path intentionally omits the recording — it's
 * a multi-file artifact (see design doc §8).
 *
 * Returns absolute paths so callers (HTTP endpoint, console UI) can show them
 * to the user verbatim.
 */
export async function exportSession({ sessionDir, session }) {
  const date = dateSlug();
  const ts = timestampSlug();
  const n = await nextVersion(sessionDir, date);
  const versionedFile = path.join(sessionDir, `artifact-${date}-v${n}.html`);
  const bundleDir = path.join(sessionDir, 'exports', `${ts}-v${n}`);

  // 1. Versioned self-contained file. buildArtifact is idempotent: pass the
  //    same session doc, get the same bytes (modulo `data:` URL ordering).
  await buildArtifact({ sessionDir, session, outPath: versionedFile });

  // 2. Directory bundle. `recursive: true` makes the parent `exports/` lazily.
  await fs.mkdir(path.join(bundleDir, 'screenshots'), { recursive: true });
  await fs.copyFile(versionedFile, path.join(bundleDir, 'artifact.html'));
  await fs.writeFile(
    path.join(bundleDir, 'session.json'),
    JSON.stringify(session, null, 2),
    'utf8',
  );
  // Copy every screenshot the session actually references. Missing files are
  // logged (not fatal) so the bundle still ships if one shot is somehow gone.
  for (const view of session.views || []) {
    if (!view.screenshot) continue;
    const from = path.join(sessionDir, view.screenshot);
    const to = path.join(bundleDir, view.screenshot);
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    } catch (err) {
      console.warn(`exportSession: skipped ${view.screenshot}:`, err.message);
    }
  }
  // Spike 8 replay pair. Both emitters are pure (session doc → text) and read
  // only `views[].steps[]` + `preconditionSteps[]`, already redacted at capture
  // time. A session with no recorded steps still emits both files — each with a
  // "no recorded steps" placeholder — so the bundle shape is stable.
  const { text: specText } = emitRecordingSpec(session);
  await fs.writeFile(path.join(bundleDir, 'recording.spec.ts'), specText, 'utf8');
  await fs.writeFile(path.join(bundleDir, 'recording-steps.md'), emitRecordingSteps(session), 'utf8');

  await fs.writeFile(
    path.join(bundleDir, 'README.md'),
    'Design QA export.\n\n'
      + '- `artifact.html` — opens standalone in any browser; filter, sort, and resolve comments.\n'
      + '- `session.json` — the source data the artifact embeds, for inspection.\n'
      + '- `screenshots/` — every screen image the session references.\n'
      + '- `recording.spec.ts` — a runnable Playwright spec replaying the reviewer\'s path. '
      + 'Run with `npx playwright test recording.spec.ts`. Credentials were redacted to '
      + '`process.env.DESIGN_QA_FIELD_*` references — set those before running.\n'
      + '- `recording-steps.md` — the same path written out as human-followable steps.\n',
    'utf8',
  );

  return { versionedFile, bundleDir };
}

function renderHtml(session, moduleImports, styles) {
  const title = `Design QA — ${escapeHtml(session.name || '')}`;
  const viewCount = session.views.length;
  const pinCount = session.views.reduce((a, v) => a + v.pins.length, 0);
  // Escape `<` so neither block can break out of its <script> element.
  const sessionJson = JSON.stringify(session).replace(/</g, '\\u003c');
  const importMap = JSON.stringify({ imports: moduleImports }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark" data-surface="cool" data-shadows="default" data-density="comfortable">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
${styles}</style>
</head>
<body>
<!-- DesignOS App Frame (read-mostly artifact: no Share / live / add-pin). Mirrors
     console/index.html so the same render modules drive both surfaces. -->
<div class="app" id="app">
  <div class="body">
    <aside class="sidebar" id="leftSidebar">
      <div class="brand-row">
        <span class="brand-mark" title="Design QA">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>
        </span>
      </div>
      <div class="file-header">
        <div class="file-name-row"><span class="file-name" id="sessionName">Design QA</span></div>
        <div class="file-sub" id="sessionMeta"></div>
      </div>
      <div class="sidebar-search">
        <span class="search-well">
          <svg class="search-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input class="search-input" id="screenSearch" type="text" placeholder="Search screens" autocomplete="off">
        </span>
      </div>
      <div class="section-header"><span class="eyebrow" id="sidebarMeta">Screens</span></div>
      <div class="view-list" id="viewList"></div>
    </aside>

    <main class="canvas-pane">
      <div class="canvas dotgrid" id="canvas"></div>
      <div class="canvas-cluster"><span class="cluster-hint" id="canvasHint">Click a pin to read it.</span></div>
    </main>

    <aside class="comments" id="rightPane">
      <div class="tabs" role="tablist">
        <button class="tab active" id="tabComments" role="tab" data-tab="comments">Comments</button>
        <button class="tab" id="tabSteps" role="tab" data-tab="steps">Steps</button>
      </div>
      <div class="comments-search-row" id="commentsSearchRow">
        <span class="search-well">
          <svg class="search-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input class="search-input" id="commentSearch" type="text" placeholder="Search comments" autocomplete="off">
        </span>
        <button class="icon-btn" id="overflowBtn" title="Filters & sort" aria-haspopup="true" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/></svg>
        </button>
        <div class="overflow-menu" id="overflowMenu" hidden>
          <label class="overflow-row"><span>Status</span>
            <select class="select" id="filterStatus">
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
          <label class="overflow-row"><span>Category</span>
            <select class="select" id="filterCategory"><option value="all">All categories</option></select>
          </label>
          <label class="overflow-row"><span>Sort</span>
            <select class="select" id="sortBy">
              <option value="created">Created</option>
              <option value="status">Status</option>
              <option value="category">Category</option>
            </select>
          </label>
        </div>
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
