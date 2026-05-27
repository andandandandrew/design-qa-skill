import { createStore } from './store/index.mjs';
import { createApp, wireControls } from './core.mjs';
import { setupResizers } from './ui/resizers.mjs';

/**
 * Console bootstrap. The shared engine (core.mjs) owns state + render; this
 * file adds only the console's live chrome — the Add-pin button, the live
 * badge, the session switcher, SSE-driven re-render, and resizable panes. The
 * exported artifact wraps the same engine with its own (read-mostly) bootstrap.
 */
async function main() {
  const store = await createStore();

  const ctx = createApp({
    store,
    mounts: {
      sidebar: document.getElementById('viewList'),
      canvas: document.getElementById('canvas'),
      comments: document.getElementById('commentsList'),
      onRender: renderConsoleChrome,
    },
    // The console is the full authoring surface: everything is enabled, and a
    // capture browser may own an unsealed screen (liveCapture).
    options: {
      canPlacePins: true, canEditNotes: true, canResolve: true, canDelete: true,
      liveCapture: true, author: 'Andrew Frank', // Phase 6 sources author from config
    },
  });

  wireControls(ctx);

  // Add pin (console only — the artifact has no placement affordance).
  document.getElementById('addPinBtn')?.addEventListener('click', () => {
    if (ctx.isLocked(ctx.activeView())) return; // can't place on a live browser screen
    ctx.setState({ placeMode: !ctx.state.placeMode, composer: null });
  });

  // Re-render on any store mutation. With HttpStore this is also driven by SSE
  // (a pin placed in the capture browser refreshes the doc → re-render here).
  store.subscribe(() => ctx.render());

  // Resizable sidebars (drag the pane boundaries).
  setupResizers(document.querySelector('.body'));

  // Minimal session switcher — only when served live (HttpStore exposes it).
  if (typeof store.listSessions === 'function') setupSwitcher(ctx, store);

  ctx.render();
}

/** Console-only top-bar chrome: live badge + the Add-pin button's state. The
 *  generic counters/hint are handled in core's render. */
function renderConsoleChrome(ctx) {
  const views = ctx.store.session.views;
  const capturing = views.some((v) => v.source === 'browser' && !v.sealedAt);
  const liveBadge = document.getElementById('liveBadge');
  if (liveBadge) liveBadge.classList.toggle('on', capturing);

  const locked = ctx.isLocked(ctx.activeView());
  const addPin = document.getElementById('addPinBtn');
  if (addPin) {
    addPin.disabled = locked;
    addPin.classList.toggle('active', ctx.state.placeMode && !locked);
    addPin.textContent = ctx.state.placeMode && !locked ? '✕ Cancel' : '+ Add pin';
  }
}

/**
 * Populate a topbar dropdown from /api/sessions. Selecting another *live*
 * session navigates to its own server's console; ended sessions are listed but
 * not yet openable (cross-session editing is Phase 6 lookback).
 */
async function setupSwitcher(ctx, store) {
  const sel = document.createElement('select');
  sel.className = 'select';
  sel.id = 'sessionSwitcher';
  sel.title = 'Switch session';
  document.getElementById('sessionName').after(sel);

  const fill = async () => {
    let sessions = [];
    try { sessions = await store.listSessions(); } catch { return; }
    sel.replaceChildren(...sessions.map((s) => {
      const o = document.createElement('option');
      o.value = s.consoleUrl || '';
      o.dataset.current = String(!!s.current);
      const dot = s.live ? '● ' : '';
      o.textContent = `${dot}${s.name} · ${s.pinCount} pins · ${s.unresolved} open`;
      if (s.current) o.selected = true;
      if (!s.live && !s.current) o.disabled = true; // not openable yet
      return o;
    }));
  };

  sel.addEventListener('change', () => {
    const url = sel.value;
    const opt = sel.selectedOptions[0];
    if (!opt || opt.dataset.current === 'true') return;
    if (url) window.location.href = url;
    else fill(); // not openable — restore selection
  });

  await fill();
  store.subscribe(() => { fill(); }); // refresh counts/live state on changes
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f0616d">Console failed to load:\n${err.stack || err}</pre>`;
});
