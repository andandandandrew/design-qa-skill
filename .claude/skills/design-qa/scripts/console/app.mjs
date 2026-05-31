import { createStore } from './store/index.mjs';
import { createApp, wireControls } from './core.mjs';
import { setupResizers } from './ui/resizers.mjs';
import { showToast } from './ui/toast.mjs';
import { el } from './lib/dom.mjs';
import { icon } from './ui/icons.mjs';
import { openMenu } from './ui/menu.mjs';

/**
 * Console bootstrap. The shared engine (core.mjs) owns state + render; this
 * file adds only the console's live chrome — the Add-pin button, the live
 * badge, the session switcher, SSE-driven re-render, and resizable panes. The
 * exported artifact wraps the same engine with its own (read-mostly) bootstrap.
 *
 * Phase 6 (reshaped 2026-05-28): two console modes coexist behind one
 * bootstrap, but they share the SAME affordance set — an archived session is
 * fully editable (add pins, edit notes, resolve, delete, manual upload, export).
 * The only thing the lookback mode does differently is swap the "● live" badge
 * for "⌛ Archived" so the user knows no capture browser is attached, and
 * route writes to a sibling SessionStore on the server via `?id=<basename>`.
 * Author comes from the session document (stamped at start from
 * `design-qa.config.json`); no more hardcoded identity.
 */
async function main() {
  const store = await createStore();
  const lookback = !!store.isLookback;
  const author = store.session.author?.name ?? null;

  const ctx = createApp({
    store,
    mounts: {
      sidebar: document.getElementById('viewList'),
      canvas: document.getElementById('canvas'),
      comments: document.getElementById('commentsList'),
      onRender: renderConsoleChrome,
    },
    // Same affordances in both modes — lookback is just "live without a capture
    // browser attached." liveCapture stays true only when a Playwright browser
    // might own an unsealed screen, which an archived session never has.
    options: {
      canPlacePins: true, canEditNotes: true, canResolve: true, canDelete: true,
      liveCapture: !lookback, author,
    },
  });

  wireControls(ctx);

  // Add pin / Draw — the two tools applicable to a frozen screenshot. Each is
  // mutually exclusive with the other (and with the composer). The isLocked()
  // guard only fires for an unsealed browser view (live owned session only).
  document.getElementById('addPinBtn')?.addEventListener('click', () => {
    if (ctx.isLocked(ctx.activeView())) return;
    ctx.setState({ placeMode: !ctx.state.placeMode, drawMode: false, composer: null });
  });
  document.getElementById('drawBtn')?.addEventListener('click', () => {
    if (ctx.isLocked(ctx.activeView())) return;
    ctx.setState({ drawMode: !ctx.state.drawMode, placeMode: false, composer: null });
  });

  // Add screen (manual upload) — every store that exposes addManualScreen.
  const addScreenBtn = document.getElementById('addScreenBtn');
  if (addScreenBtn && typeof store.addManualScreen === 'function') {
    addScreenBtn.disabled = false;
    addScreenBtn.title = 'Upload a screenshot to comment on';
    addScreenBtn.addEventListener('click', () => pickAndUploadScreen(ctx, store));
  }

  // Export (Phase 7) — works for the owned live session AND archived siblings
  // (lookback). Both HttpStore and LookbackStore expose `listSessions`, which is
  // the live-store marker (the MemoryStore fixture doesn't); a lookback export
  // threads its `?id=<basename>` through to the sibling-export branch in
  // http-server's handleExport.
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn && typeof store.listSessions === 'function') {
    const exportId = lookback ? store.basename : null;
    exportBtn.disabled = false;
    exportBtn.title = 'Share this session as a single file or zipped bundle';
    exportBtn.addEventListener('click', () => openExportChooser(exportBtn, exportId));
  }

  // Re-render on any store mutation. With HttpStore this is also driven by SSE
  // (a pin placed in the capture browser refreshes the doc → re-render here).
  store.subscribe(() => ctx.render());

  // Resizable sidebars (drag the pane boundaries).
  setupResizers(document.querySelector('.body'));

  // Topbar session switcher — works in both live and lookback modes.
  if (typeof store.listSessions === 'function') setupSwitcher(ctx, store, lookback);

  ctx.render();
}

/**
 * Manual-upload flow: pick an image → name it → upload → select the new screen.
 * Naming uses window.prompt (the console runs in the user's normal browser, so
 * native dialogs work here — unlike the Playwright overlay). Intrinsic image
 * dimensions are read client-side (works for any browser-supported format) and
 * sent along, so the server never has to decode the image.
 */
function pickAndUploadScreen(ctx, store) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const defaultName = file.name.replace(/\.[^.]+$/, '');
    const name = window.prompt('Name this screen:', defaultName);
    if (name === null) return; // cancelled
    let dims = { width: null, height: null };
    try { dims = await imageDimensions(file); } catch { /* dims optional */ }
    try {
      const viewId = await store.addManualScreen({
        name: name.trim() || defaultName, file, width: dims.width, height: dims.height,
      });
      ctx.setState({ activeViewId: viewId, activePinId: null, placeMode: false, composer: null });
    } catch (err) {
      alert(`Upload failed: ${err.message || err}`);
    }
  }, { once: true });
  input.click();
}

/** Read an image file's intrinsic dimensions without uploading it. */
function imageDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/** Console-only top-bar chrome: live/archived badge + the Add-pin button's
 *  state. The generic counters/hint are handled in core's render. */
function renderConsoleChrome(ctx) {
  const lookback = !!ctx.store.isLookback;
  const views = ctx.store.session.views;
  const liveBadge = document.getElementById('liveBadge');
  if (liveBadge) {
    if (lookback) {
      liveBadge.classList.remove('on');
      liveBadge.classList.add('archived');
      liveBadge.title = 'Editing an archived session (no live capture)';
      liveBadge.textContent = '⌛ Archived';
    } else {
      liveBadge.classList.remove('archived');
      const capturing = views.some((v) => v.source === 'browser' && !v.sealedAt);
      liveBadge.classList.toggle('on', capturing);
    }
  }

  const locked = ctx.isLocked(ctx.activeView());
  const addPin = document.getElementById('addPinBtn');
  if (addPin) {
    addPin.disabled = locked;
    addPin.classList.toggle('active', ctx.state.placeMode && !locked);
  }
  const draw = document.getElementById('drawBtn');
  if (draw) {
    draw.disabled = locked;
    draw.classList.toggle('active', ctx.state.drawMode && !locked);
  }
}

/**
 * Populate a topbar dropdown from /api/sessions. Selecting another session
 * navigates either to its own live server (live siblings → `consoleUrl`) or to
 * the current server's lookback path (ended siblings → `lookbackUrl =
 * ?session=<basename>`). The lookback view runs in-place on the current port.
 */
async function setupSwitcher(ctx, store, lookback) {
  const nameEl = document.getElementById('sessionName');
  if (!nameEl) return;

  // DesignOS FileTrigger: a chevron-down next to the session name; clicking it
  // opens a DesignOS-style Menu listing every session in the directory. Live
  // siblings navigate to their own server; ended ones open in-place via the
  // lookback URL. (Replaces the old <select> switcher.)
  const btn = el('button', { class: 'file-menu-trigger', id: 'sessionMenuBtn', title: 'Switch session', 'aria-haspopup': 'true' });
  btn.append(icon('chevDown', 13));
  nameEl.after(btn);

  // In lookback mode "current" (server POV) is the OWNED session, not the one
  // being viewed; match the URL `?session=` basename instead.
  const lookbackBase = lookback
    ? new URLSearchParams(window.location.search).get('session')
    : null;

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    let sessions = [];
    try { sessions = await store.listSessions(); } catch { return; }
    const items = sessions.map((s) => {
      const here = lookback
        ? (s.sessionDir.endsWith(`/${lookbackBase}`) || s.sessionDir.endsWith(`\\${lookbackBase}`))
        : !!s.current;
      const url = s.live ? (s.consoleUrl || '') : (s.lookbackUrl || '');
      const dot = s.live ? '● ' : (s.endedAt ? '⌛ ' : '');
      return {
        label: `${dot}${s.name} · ${s.pinCount} pins · ${s.unresolved} open`,
        checked: here,
        onClick: () => { if (!here && url) window.location.href = url; },
      };
    });
    openMenu(btn, items, { align: 'left', width: 268 });
  });
}

/**
 * Phase 7 export flow (revised 2026-05-28): a two-step chooser modal. Pick
 * "Single HTML file" or "Bundle (zip)" → Next → the browser opens its native
 * save dialog at the path the user picks. The server still writes a silent
 * archive to `<sessionDir>/exports/` and `<sessionDir>/artifact-*-vN.html` on
 * every export (project record); the user-facing flow only surfaces the
 * save-as path so "Export" reads the same way it does in any other app.
 */
function openExportChooser(btn, exportId = null) {
  closeExportDialog();

  let kind = 'single'; // default

  const option = (value, title, sub) => {
    const node = el('label', { class: 'export-option', 'data-value': value }, [
      el('input', { type: 'radio', name: 'dqa-export-kind', value, checked: value === kind ? true : null }),
      el('div', { class: 'export-option-body' }, [
        el('div', { class: 'export-option-title' }, title),
        el('div', { class: 'export-option-sub' }, sub),
      ]),
    ]);
    node.addEventListener('change', () => {
      kind = node.querySelector('input').value;
      dialog.querySelectorAll('.export-option').forEach((n) => n.classList.toggle('selected', n.dataset.value === kind));
    });
    if (value === kind) node.classList.add('selected');
    return node;
  };

  const nextBtn = el('button', { class: 'btn primary', onclick: async () => {
    nextBtn.disabled = true;
    cancelBtn.disabled = true;
    nextBtn.textContent = 'Sharing…';
    try {
      await runSaveDialog(kind, exportId);
      closeExportDialog();
    } catch (err) {
      // AbortError from the picker is "user cancelled" — silent.
      if (err?.name !== 'AbortError') showToast(`Share failed: ${err.message || err}`);
      nextBtn.disabled = false;
      cancelBtn.disabled = false;
      nextBtn.textContent = 'Next';
    }
  } }, 'Next');
  const cancelBtn = el('button', { class: 'btn', onclick: closeExportDialog }, 'Cancel');

  const dialog = el('div', { class: 'export-dialog', role: 'dialog', 'aria-label': 'Share' }, [
    el('div', { class: 'export-dialog-head' }, [
      el('div', { class: 'export-dialog-title' }, 'Share'),
      el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeExportDialog }, '×'),
    ]),
    el('div', { class: 'export-options' }, [
      option('single', 'Share as single file',
        'One self-contained HTML artifact. Opens in any browser; engineer can filter, sort, and resolve comments. (No replay script.)'),
      option('bundle', 'Share as bundle (zip)',
        'Zipped folder: artifact.html + session.json + screenshots + replay script. For checking into a repo or sharing inspectable source.'),
    ]),
    el('div', { class: 'export-dialog-foot' }, [cancelBtn, nextBtn]),
  ]);

  const backdrop = el('div', { class: 'export-backdrop', id: 'dqa-export-backdrop', onclick: (e) => {
    if (e.target === backdrop) closeExportDialog();
  } }, [dialog]);

  document.body.appendChild(backdrop);
  document.addEventListener('keydown', exportDialogKeydown);
  // Focus the Next button so Enter confirms immediately.
  nextBtn.focus();
}

/**
 * Fetch the chosen export shape from the server and hand the bytes to the
 * browser's native save dialog. `showSaveFilePicker` (Chromium-only) is the
 * preferred path — it pops a real OS dialog and lets the user place the file
 * exactly where they want. The fallback (`<a download>`) is a plain
 * browser-download (goes to the user's Downloads folder) for Safari/Firefox.
 */
async function runSaveDialog(kind, exportId = null) {
  let url = `/api/export?kind=${encodeURIComponent(kind)}`;
  if (exportId) url += `&id=${encodeURIComponent(exportId)}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  const filename = filenameFromContentDisposition(res.headers.get('content-disposition')) || (kind === 'bundle' ? 'design-qa-export.zip' : 'design-qa-export.html');
  const blob = await res.blob();

  if (typeof window.showSaveFilePicker === 'function') {
    const types = kind === 'bundle'
      ? [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }]
      : [{ description: 'HTML file', accept: { 'text/html': ['.html'] } }];
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: filename, types });
    } catch (err) {
      // User cancelled the picker — propagate so the caller can stay silent.
      throw err;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    showToast(`Saved ${handle.name}`);
    return;
  }

  // Cross-browser fallback: trigger a normal download → user's default folder.
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
  showToast(`Downloaded ${filename}`);
}

/** Pull `filename="..."` out of a Content-Disposition header; null if absent. */
function filenameFromContentDisposition(header) {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return m ? decodeURIComponent(m[1]) : null;
}

function exportDialogKeydown(e) {
  if (e.key === 'Escape') closeExportDialog();
}

function closeExportDialog() {
  const node = document.getElementById('dqa-export-backdrop');
  if (node) node.remove();
  document.removeEventListener('keydown', exportDialogKeydown);
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f0616d">Console failed to load:\n${err.stack || err}</pre>`;
});
