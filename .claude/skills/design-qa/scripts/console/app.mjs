import { createStore } from './store/index.mjs';
import { createApp, wireControls } from './core.mjs';
import { setupResizers } from './ui/resizers.mjs';

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

  // Add pin — same gesture in both modes. The isLocked() guard only fires for
  // an unsealed browser view, which only exists on the live owned session.
  document.getElementById('addPinBtn')?.addEventListener('click', () => {
    if (ctx.isLocked(ctx.activeView())) return;
    ctx.setState({ placeMode: !ctx.state.placeMode, composer: null });
  });

  // Add screen (manual upload) — every store that exposes addManualScreen.
  const addScreenBtn = document.getElementById('addScreenBtn');
  if (addScreenBtn && typeof store.addManualScreen === 'function') {
    addScreenBtn.disabled = false;
    addScreenBtn.title = 'Upload a screenshot to comment on';
    addScreenBtn.addEventListener('click', () => pickAndUploadScreen(ctx, store));
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
    addPin.textContent = ctx.state.placeMode && !locked ? '✕ Cancel' : '+ Add pin';
  }
}

/**
 * Populate a topbar dropdown from /api/sessions. Selecting another session
 * navigates either to its own live server (live siblings → `consoleUrl`) or to
 * the current server's lookback path (ended siblings → `lookbackUrl =
 * ?session=<basename>`). The lookback view runs in-place on the current port.
 */
async function setupSwitcher(ctx, store, lookback) {
  const sel = document.createElement('select');
  sel.className = 'select';
  sel.id = 'sessionSwitcher';
  sel.title = 'Switch session';
  document.getElementById('sessionName').after(sel);

  // In lookback mode, "current" from the server's POV is the OWNED session,
  // not the one we're viewing. Highlight the one whose basename matches the
  // URL `?session=` instead.
  const lookbackBase = lookback
    ? new URLSearchParams(window.location.search).get('session')
    : null;

  const fill = async () => {
    let sessions = [];
    try { sessions = await store.listSessions(); } catch { return; }
    sel.replaceChildren(...sessions.map((s) => {
      const o = document.createElement('option');
      // Live → that session's own URL. Ended → this server's lookback URL.
      o.value = s.live ? (s.consoleUrl || '') : (s.lookbackUrl || '');
      const here = lookback
        ? (s.sessionDir.endsWith(`/${lookbackBase}`) || s.sessionDir.endsWith(`\\${lookbackBase}`))
        : !!s.current;
      o.dataset.here = String(here);
      const dot = s.live ? '● ' : (s.endedAt ? '⌛ ' : '');
      o.textContent = `${dot}${s.name} · ${s.pinCount} pins · ${s.unresolved} open`;
      if (here) o.selected = true;
      if (!o.value && !here) o.disabled = true; // no URL to navigate to
      return o;
    }));
  };

  sel.addEventListener('change', () => {
    const url = sel.value;
    const opt = sel.selectedOptions[0];
    if (!opt || opt.dataset.here === 'true') return;
    if (url) window.location.href = url;
    else fill(); // not openable — restore selection
  });

  await fill();
  store.subscribe(() => { fill(); }); // refresh counts/live state on changes
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f0616d">Console failed to load:\n${err.stack || err}</pre>`;
});
