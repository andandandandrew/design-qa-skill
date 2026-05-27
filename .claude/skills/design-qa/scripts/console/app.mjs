import { createStore } from './store/index.mjs';
import { setupResizers } from './ui/resizers.mjs';
import { renderSidebar } from './ui/sidebar.mjs';
import { renderCanvas } from './ui/canvas.mjs';
import { renderComments } from './ui/comments.mjs';

const CATEGORIES = ['spacing', 'color', 'text', 'interaction', 'code-pattern', 'component', 'workflow', 'page'];

/**
 * Console bootstrap. Owns shared UI state and a single render() that fans out to
 * the three panes. The store is the persistence seam; UI state (active screen,
 * selected pin, place mode, filters) lives here, never in the store.
 */
async function main() {
  const store = await createStore();

  const state = {
    activeViewId: store.session.views[0]?.id || null,
    activePinId: null,
    placeMode: false,
    composer: null, // {viewId, xPct, yPct} while a new pin is being authored
    filters: { status: 'all', category: 'all', sortBy: 'created' },
    author: 'Andrew Frank', // Phase 6 sources this from config
  };

  const ctx = {
    store,
    state,
    CATEGORIES,
    setState(patch) { Object.assign(state, patch); ctx.render(); },
    activeView() { return store.getView(state.activeViewId); },
    /** Live-screen ownership (§6): an unsealed browser view is browser-owned
     *  and read-only in the console — it's being captured in the overlay. */
    isLocked(view) { return !!view && view.source === 'browser' && !view.sealedAt; },
    /** Filtered + sorted + index-stamped pins for a screen. Index follows
     *  creation order so marker numbers stay stable regardless of sort. */
    visiblePins(view) {
      if (!view) return [];
      const ordered = [...view.pins].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      const indexed = ordered.map((p, i) => ({ ...p, index: i + 1 }));
      const f = state.filters;
      let out = indexed.filter((p) =>
        (f.status === 'all' || p.status === f.status) &&
        (f.category === 'all' || p.category === f.category));
      if (f.sortBy === 'status') out.sort((a, b) => a.status.localeCompare(b.status));
      else if (f.sortBy === 'category') out.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
      return out;
    },
    render() {
      renderTopbar(ctx);
      renderSidebar(ctx, els.sidebar);
      renderCanvas(ctx, els.canvas);
      renderComments(ctx, els.comments);
    },
  };

  const els = {
    sidebar: document.getElementById('viewList'),
    canvas: document.getElementById('canvas'),
    comments: document.getElementById('commentsList'),
  };

  // Topbar / toolbar wiring.
  document.getElementById('addPinBtn').addEventListener('click', () => {
    if (ctx.isLocked(ctx.activeView())) return; // can't place on a live browser screen
    ctx.setState({ placeMode: !state.placeMode, composer: null });
  });
  document.getElementById('filterStatus').addEventListener('change', (e) => {
    state.filters.status = e.target.value; ctx.render();
  });
  document.getElementById('filterCategory').addEventListener('change', (e) => {
    state.filters.category = e.target.value; ctx.render();
  });
  document.getElementById('sortBy').addEventListener('change', (e) => {
    state.filters.sortBy = e.target.value; ctx.render();
  });
  // Populate the category filter once.
  const catSel = document.getElementById('filterCategory');
  for (const c of CATEGORIES) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c[0].toUpperCase() + c.slice(1);
    catSel.append(opt);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (state.placeMode || state.composer)) {
      ctx.setState({ placeMode: false, composer: null });
    }
  });

  // Re-render on any store mutation. With HttpStore this is also driven by SSE
  // (a pin placed in the capture browser refreshes the doc → re-render here).
  store.subscribe(() => ctx.render());

  document.getElementById('sessionName').textContent = store.session.name || 'Design QA';

  // Resizable sidebars (drag the pane boundaries).
  setupResizers(document.querySelector('.body'));

  // Minimal session switcher — only when served live (HttpStore exposes it).
  if (typeof store.listSessions === 'function') setupSwitcher(ctx, store);

  ctx.render();
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

function renderTopbar(ctx) {
  const views = ctx.store.session.views;
  const pinCount = views.reduce((a, v) => a + v.pins.length, 0);
  const open = views.reduce((a, v) => a + v.pins.filter((p) => p.status !== 'resolved').length, 0);
  document.getElementById('sessionMeta').textContent =
    `${views.length} ${views.length === 1 ? 'screen' : 'screens'} · ${pinCount} pins · ${open} open`;
  document.getElementById('sidebarMeta').textContent = `${views.length} ${views.length === 1 ? 'screen' : 'screens'}`;

  // Live badge = a browser screen is currently being captured (unsealed).
  const capturing = views.some((v) => v.source === 'browser' && !v.sealedAt);
  const liveBadge = document.getElementById('liveBadge');
  if (liveBadge) liveBadge.classList.toggle('on', capturing);

  const locked = ctx.isLocked(ctx.activeView());
  const addPin = document.getElementById('addPinBtn');
  addPin.disabled = locked;
  addPin.classList.toggle('active', ctx.state.placeMode && !locked);
  addPin.textContent = ctx.state.placeMode && !locked ? '✕ Cancel' : '+ Add pin';
  document.getElementById('canvasHint').textContent = locked
    ? '● Live — being captured in the browser. Read-only here until sealed.'
    : ctx.state.placeMode
      ? 'Click on the screenshot to drop a pin.'
      : 'Click a pin to read it. Drag to move.';
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f0616d">Console failed to load:\n${err.stack || err}</pre>`;
});
