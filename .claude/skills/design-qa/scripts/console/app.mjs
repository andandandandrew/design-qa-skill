import { loadMemoryStore } from './store/memory-store.mjs';
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
  const store = await loadMemoryStore();

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

  // Re-render on any store mutation (Phase 4: SSE drives the same path).
  store.subscribe(() => ctx.render());

  document.getElementById('sessionName').textContent = store.session.name || 'Design QA';

  ctx.render();
}

function renderTopbar(ctx) {
  const views = ctx.store.session.views;
  const pinCount = views.reduce((a, v) => a + v.pins.length, 0);
  const open = views.reduce((a, v) => a + v.pins.filter((p) => p.status !== 'resolved').length, 0);
  document.getElementById('sessionMeta').textContent =
    `${views.length} ${views.length === 1 ? 'screen' : 'screens'} · ${pinCount} pins · ${open} open`;
  document.getElementById('sidebarMeta').textContent = `${views.length} ${views.length === 1 ? 'screen' : 'screens'}`;
  const addPin = document.getElementById('addPinBtn');
  addPin.classList.toggle('active', ctx.state.placeMode);
  addPin.textContent = ctx.state.placeMode ? '✕ Cancel' : '+ Add pin';
  document.getElementById('canvasHint').textContent = ctx.state.placeMode
    ? 'Click on the screenshot to drop a pin.'
    : 'Click a pin to read it. Drag to move.';
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f0616d">Console failed to load:\n${err.stack || err}</pre>`;
});
