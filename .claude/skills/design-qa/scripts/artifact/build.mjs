/**
 * Builds the exported HTML artifact from a session document.
 *
 * Layout mirrors the POC: sidebar (view list) | canvas (screenshot + pins) |
 * annotations (notes for active view). Single self-contained file with
 * base64-embedded screenshots. No completion-state UI yet (Phase 5).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

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
    return {
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      width,
      height,
    };
  } catch (err) {
    console.warn(`artifact: could not load ${abs}:`, err.message);
    return null;
  }
}

export async function buildArtifact({ sessionDir, session, outPath }) {
  const viewsData = [];
  for (const view of session.views) {
    const shot = await loadScreenshot(sessionDir, view.screenshot);
    const vp = view.viewport || { width: shot?.width || 1440, height: shot?.height || 900 };
    const dpr = shot && vp.width ? shot.width / vp.width : 1;
    const docHeightCss = shot && dpr ? shot.height / dpr : vp.height;
    viewsData.push({
      id: view.id,
      name: view.name || view.title || view.url,
      url: view.url,
      createdAt: view.createdAt,
      sealedAt: view.sealedAt,
      viewport: vp,
      screenshot: shot ? shot.dataUrl : null,
      hasScreenshot: !!shot,
      pins: view.pins.map((p, i) => ({
        id: p.id,
        index: i + 1,
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

  const meta = {
    sessionId: session.id,
    sessionName: session.name,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    viewCount: viewsData.length,
    pinCount: viewsData.reduce((a, v) => a + v.pins.length, 0),
  };

  const html = renderHtml(meta, viewsData);
  await fs.writeFile(outPath, html, 'utf8');
  return outPath;
}

function renderHtml(meta, views) {
  const title = `Design QA — ${escapeHtml(meta.sessionName)}`;
  const dataJson = JSON.stringify({ meta, views }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  :root {
    --bg: #1e1e1e; --bg-2: #2c2c2c; --bg-3: #383838; --bg-4: #444444;
    --border: #3d3d3d; --border-strong: #555555;
    --text: #eeeeee; --text-2: #a0a0a0; --text-3: #757575;
    --accent: #0d99ff; --accent-hover: #1fa9ff; --accent-dim: rgba(13,153,255,0.16);
    --selected-row: rgba(13,153,255,0.18);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: var(--bg); color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px; line-height: 1.45; overflow: hidden; -webkit-font-smoothing: antialiased; }
  .mono { font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace; font-feature-settings: 'tnum'; }
  .app { position: relative; display: grid;
    grid-template-columns: var(--col-left, 260px) 1fr var(--col-right, 360px); height: 100vh; }

  /* Sidebar resize handles — thin hit-area on each pane boundary. */
  .resizer { position: absolute; top: 0; bottom: 0; width: 8px; z-index: 50; cursor: col-resize; }
  .resizer::after { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px;
    transform: translateX(-50%); background: transparent; transition: background 0.1s; }
  .resizer:hover::after, .resizer.dragging::after { background: var(--accent); width: 2px; }
  .resizer-left { left: calc(var(--col-left, 260px) - 4px); }
  .resizer-right { right: calc(var(--col-right, 360px) - 4px); }

  .sidebar { background: var(--bg-2); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .sidebar-header { padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
  .sidebar-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); font-weight: 600; }
  .sidebar-subtitle { font-size: 14px; color: var(--text); font-weight: 600; margin-top: 4px; word-break: break-word; }
  .sidebar-meta { font-size: 11px; color: var(--text-3); margin-top: 4px; }

  .view-list { overflow-y: auto; flex: 1; padding: 6px 0; }
  .view-item { padding: 10px 16px; cursor: pointer; transition: background 0.08s; }
  .view-item:hover { background: var(--bg-3); }
  .view-item.active { background: var(--accent-dim); }
  .view-name { font-size: 12px; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .view-url { font-size: 10px; color: var(--text-3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .view-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 10px; color: var(--text-3); }
  .pin-count {
    flex-shrink: 0; padding: 1px 6px; border-radius: 999px;
    background: var(--bg-3); border: 1px solid var(--border);
    font-size: 10px; font-weight: 600; color: var(--text-2);
    font-family: 'JetBrains Mono', monospace;
  }
  .view-item.active .pin-count { background: var(--accent); color: #ffffff; border-color: transparent; }

  .canvas { background: var(--bg); overflow: auto; display: flex; align-items: flex-start; justify-content: center; padding: 24px; }
  .canvas .empty { color: var(--text-3); margin-top: 64px; font-size: 13px; }
  .screenshot-wrapper { position: relative; display: inline-block; box-shadow: 0 8px 32px rgba(0,0,0,0.45); border-radius: 6px; overflow: visible; max-width: 100%; }
  .screenshot { display: block; max-width: 100%; border-radius: 6px; }
  .no-screenshot { padding: 32px; background: var(--bg-2); border: 1px dashed var(--border); border-radius: 6px; color: var(--text-2); }

  /* Pin marker — Figma comment teardrop */
  .marker {
    position: absolute; width: 24px; height: 24px;
    background: var(--accent); color: #ffffff;
    border-radius: 100% 100% 100% 0;
    font-family: 'Inter', sans-serif;
    font-size: 10px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.4), 0 0 0 1.5px #ffffff;
    cursor: pointer; user-select: none;
    transition: transform 0.1s, background 0.1s;
    transform: translate(0, -100%); /* anchor bottom-left tail at (x, y) */
  }
  .marker > span { transform: translate(1px, -1px); }
  .marker:hover { background: var(--accent-hover); transform: translate(0, calc(-100% - 1px)); }
  .marker.active { background: var(--accent-hover); box-shadow: 0 2px 6px rgba(0,0,0,0.5), 0 0 0 1.5px #ffffff, 0 0 0 4px rgba(13,153,255,0.4); }
  @keyframes pin-pulse {
    0%   { box-shadow: 0 2px 6px rgba(0,0,0,0.5), 0 0 0 1.5px #ffffff, 0 0 0 0 rgba(13,153,255,0.6); }
    60%  { box-shadow: 0 2px 6px rgba(0,0,0,0.5), 0 0 0 1.5px #ffffff, 0 0 0 18px rgba(13,153,255,0); }
    100% { box-shadow: 0 2px 6px rgba(0,0,0,0.5), 0 0 0 1.5px #ffffff, 0 0 0 0 rgba(13,153,255,0); }
  }
  .marker.pulse { animation: pin-pulse 1s ease-out 2; }

  .annotations { background: var(--bg-2); border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .annotations-header { padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
  .annotations-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); font-weight: 600; }
  .annotations-page { font-size: 13px; color: var(--text); font-weight: 600; margin-top: 4px; line-height: 1.4; word-break: break-word; }
  .annotations-page-url { font-size: 10px; color: var(--text-3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .annotations-list { overflow-y: auto; flex: 1; padding: 8px 8px; display: flex; flex-direction: column; gap: 6px; }
  .annotation-item {
    padding: 12px 14px; border-radius: 8px;
    background: var(--bg); border: 1px solid var(--border);
    cursor: pointer; transition: background 0.08s, border-color 0.08s;
  }
  .annotation-item:hover { background: var(--bg-3); border-color: var(--border-strong); }
  .annotation-item.active { background: var(--selected-row); border-color: transparent; }
  .annotation-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .annotation-number {
    flex-shrink: 0;
    width: 18px; height: 18px;
    background: var(--accent); color: #ffffff;
    border-radius: 100% 100% 100% 0;
    font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .annotation-meta { font-size: 11px; color: var(--text-2); }
  .annotation-description { font-size: 13px; color: var(--text); line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
  .annotation-description.empty { color: var(--text-3); font-style: italic; }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-title">Design QA</div>
      <div class="sidebar-subtitle">${escapeHtml(meta.sessionName)}</div>
      <div class="sidebar-meta mono">${fmtDate(meta.createdAt)} · ${meta.viewCount} ${meta.viewCount === 1 ? 'screen' : 'screens'} · ${meta.pinCount} ${meta.pinCount === 1 ? 'pin' : 'pins'}</div>
    </div>
    <div class="view-list" id="viewList"></div>
  </aside>
  <main class="canvas" id="canvas"></main>
  <aside class="annotations">
    <div class="annotations-header">
      <div class="annotations-title">Comments</div>
      <div class="annotations-page" id="annotationsPage">—</div>
      <div class="annotations-page-url" id="annotationsPageUrl"></div>
    </div>
    <div class="annotations-list" id="annotationsList"></div>
  </aside>
</div>
<script id="data" type="application/json">${dataJson}</script>
<script>
(() => {
  const DATA = JSON.parse(document.getElementById('data').textContent);
  const { meta, views } = DATA;
  let activeViewId = views[0]?.id || null;
  let activeAnnotationId = null;

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function renderViewList() {
    const list = $('viewList');
    list.innerHTML = views.map((v) => \`
      <div class="view-item \${v.id === activeViewId ? 'active' : ''}" data-id="\${v.id}">
        <div class="view-name">\${escapeHtml(v.name)}</div>
        <div class="view-url" title="\${escapeHtml(v.url)}">\${escapeHtml(v.url)}</div>
        <div class="view-meta">
          <span class="mono">\${(v.createdAt || '').slice(0,10)}</span>
          <span class="pin-count mono">\${v.pins.length}</span>
        </div>
      </div>
    \`).join('');
    list.querySelectorAll('.view-item').forEach((el) => {
      el.addEventListener('click', () => {
        activeViewId = el.dataset.id;
        activeAnnotationId = null;
        renderAll();
      });
    });
  }

  function renderCanvas() {
    const canvas = $('canvas');
    const view = views.find((v) => v.id === activeViewId);
    if (!view) { canvas.innerHTML = '<div class="empty">No screen selected.</div>'; return; }
    if (!view.hasScreenshot) {
      canvas.innerHTML = \`<div class="no-screenshot">No screenshot captured for this screen.<br><br>\${view.pins.length} pin\${view.pins.length === 1 ? '' : 's'} stored.</div>\`;
      return;
    }
    canvas.innerHTML = \`
      <div class="screenshot-wrapper" id="ssw">
        <img class="screenshot" src="\${view.screenshot}" alt="\${escapeHtml(view.name)}" />
        \${view.pins.map((p) => \`
          <div class="marker \${p.id === activeAnnotationId ? 'active' : ''}" data-id="\${p.id}" style="left:\${p.xPct}%;top:\${p.yPct}%;"><span>\${p.index}</span></div>
        \`).join('')}
      </div>
    \`;
    canvas.querySelectorAll('.marker').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        activeAnnotationId = activeAnnotationId === id ? null : id;
        renderAll();
        const target = document.querySelector(\`.annotation-item[data-id="\${id}"]\`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  function renderAnnotations() {
    const list = $('annotationsList');
    const pageEl = $('annotationsPage');
    const urlEl = $('annotationsPageUrl');
    const view = views.find((v) => v.id === activeViewId);
    if (!view) { pageEl.textContent = '—'; urlEl.textContent = ''; list.innerHTML = ''; return; }
    pageEl.textContent = view.name;
    urlEl.textContent = view.url;
    urlEl.title = view.url;
    if (view.pins.length === 0) {
      list.innerHTML = '<div style="padding:18px 14px;color:var(--text-3);">No pins on this screen.</div>';
      return;
    }
    list.innerHTML = view.pins.map((p) => \`
      <div class="annotation-item \${p.id === activeAnnotationId ? 'active' : ''}" data-id="\${p.id}">
        <div class="annotation-head">
          <div class="annotation-number">\${p.index}</div>
          <div class="annotation-meta mono">\${(p.createdAt || '').slice(0,16).replace('T',' ')}</div>
        </div>
        <div class="annotation-description \${p.note ? '' : 'empty'}">\${p.note ? escapeHtml(p.note) : '(no comment)'}</div>
      </div>
    \`).join('');
    list.querySelectorAll('.annotation-item').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        activateFromAnnotation(id);
      });
    });
  }

  function activateFromAnnotation(id) {
    activeAnnotationId = activeAnnotationId === id ? null : id;
    renderAll();
    if (!activeAnnotationId) return;
    const marker = document.querySelector(\`.marker[data-id="\${id}"]\`);
    if (!marker) return;
    // Scroll the canvas so the marker is centered in view.
    const canvas = $('canvas');
    const cRect = canvas.getBoundingClientRect();
    const mRect = marker.getBoundingClientRect();
    const dx = (mRect.left - cRect.left) - (cRect.width / 2 - mRect.width / 2);
    const dy = (mRect.top - cRect.top) - (cRect.height / 2 - mRect.height / 2);
    canvas.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    // Pulse the marker so the user can see which one was clicked.
    marker.classList.remove('pulse');
    void marker.offsetWidth; // restart animation
    marker.classList.add('pulse');
  }

  function renderAll() { renderViewList(); renderCanvas(); renderAnnotations(); }
  renderAll();

  // --- Resizable sidebars (drag the pane boundaries) ---
  (function setupResizers() {
    const MIN = 180, MAX = 560, KEY = '__dqa_artifact_cols';
    const app = document.querySelector('.app');
    const clamp = (n) => Math.max(MIN, Math.min(MAX, Number(n) || 0));
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
    if (saved.left) app.style.setProperty('--col-left', clamp(saved.left) + 'px');
    if (saved.right) app.style.setProperty('--col-right', clamp(saved.right) + 'px');
    const persist = () => {
      const read = (v, fb) => parseInt(getComputedStyle(app).getPropertyValue(v), 10) || fb;
      try { localStorage.setItem(KEY, JSON.stringify({ left: read('--col-left', 260), right: read('--col-right', 360) })); } catch (e) {}
    };
    ['left', 'right'].forEach((side) => {
      const h = document.createElement('div');
      h.className = 'resizer resizer-' + side;
      app.appendChild(h);
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        h.classList.add('dragging');
        const rect = app.getBoundingClientRect();
        const onMove = (ev) => {
          const w = clamp(side === 'left' ? ev.clientX - rect.left : rect.right - ev.clientX);
          app.style.setProperty('--col-' + side, w + 'px');
        };
        const onUp = () => {
          h.releasePointerCapture(e.pointerId);
          h.classList.remove('dragging');
          h.removeEventListener('pointermove', onMove);
          h.removeEventListener('pointerup', onUp);
          persist();
        };
        h.addEventListener('pointermove', onMove);
        h.addEventListener('pointerup', onUp);
      });
    });
  })();
})();
</script>
</body>
</html>`;
}
