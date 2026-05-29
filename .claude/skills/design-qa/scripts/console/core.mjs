import { renderSidebar } from './ui/sidebar.mjs';
import { renderCanvas } from './ui/canvas.mjs';
import { renderComments } from './ui/comments.mjs';

/**
 * The shared review/authoring engine — one renderer, two outputs.
 *
 * `createApp` owns the UI state (active screen, selected pin, place mode,
 * composer, filters) and a single `render()` that fans out to the three panes
 * (sidebar / canvas / comments). It is agnostic to *which* store it has (live
 * HttpStore in the console, embedded ArtifactStore in the exported file) and to
 * *which* affordances are enabled — those are gated by `options`.
 *
 * The console (`app.mjs`) wraps this with its live chrome (session switcher,
 * SSE, live badge, Add-pin button, resizers). The exported `artifact.html`
 * wraps the *same* module source with read-mostly options. Neither pane module
 * knows the difference; both only see `ctx`.
 */

export const CATEGORIES = [
  'spacing', 'color', 'text', 'interaction', 'code-pattern', 'component', 'workflow', 'page',
];

const DEFAULT_OPTIONS = {
  canPlacePins: false, // Add pin + drag-to-move (repositioning is a placement op)
  canEditNotes: false, // edit note text + set category
  canResolve: false,   // resolve / check-off (+ completion note)
  canDelete: false,    // delete a pin
  liveCapture: false,  // a capture browser may own an unsealed screen (console only)
  author: null,        // stamped onto pins created here
};

export function createApp({ store, mounts, options = {} }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const state = {
    activeViewId: store.session.views[0]?.id || null,
    activePinId: null,
    placeMode: false,
    composer: null, // {viewId, xPct, yPct} while a new pin is being authored
    filters: { status: 'all', category: 'all', sortBy: 'created' },
    author: opts.author,
  };

  const ctx = {
    store,
    state,
    options: opts,
    CATEGORIES,
    setState(patch) { Object.assign(state, patch); ctx.render(); },
    activeView() { return store.getView(state.activeViewId); },
    /** Live-screen ownership (§6): an unsealed browser view is owned by the
     *  capture overlay and read-only here. Only relevant while capturing —
     *  the exported artifact is frozen, so liveCapture is off there. */
    isLocked(view) {
      return opts.liveCapture && !!view && view.source === 'browser' && !view.sealedAt;
    },
    /** Filtered + sorted + index-stamped pins for a screen. Index follows
     *  creation order so marker numbers stay stable regardless of sort. */
    visiblePins(view) {
      if (!view) return [];
      const ordered = [...view.pins].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      const indexed = ordered.map((p, i) => ({ ...p, index: i + 1 }));
      const f = state.filters;
      const out = indexed.filter((p) =>
        (f.status === 'all' || p.status === f.status) &&
        (f.category === 'all' || p.category === f.category));
      if (f.sortBy === 'status') out.sort((a, b) => a.status.localeCompare(b.status));
      else if (f.sortBy === 'category') out.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
      return out;
    },
    render() {
      renderSidebar(ctx, mounts.sidebar);
      renderCanvas(ctx, mounts.canvas);
      renderComments(ctx, mounts.comments);
      updateChrome(ctx);
      mounts.onRender?.(ctx); // host-specific chrome (console live badge etc.)
    },
  };

  return ctx;
}

/** Generic top-bar counters + canvas hint, both surfaces share. Guarded by
 *  element presence so a host that omits one simply skips it. */
function updateChrome(ctx) {
  const views = ctx.store.session.views;
  const pinCount = views.reduce((a, v) => a + v.pins.length, 0);
  const open = views.reduce((a, v) => a + v.pins.filter((p) => p.status !== 'resolved').length, 0);
  const screens = `${views.length} ${views.length === 1 ? 'screen' : 'screens'}`;

  setText('sessionMeta', `${screens} · ${pinCount} pins · ${open} open`);
  setText('sidebarMeta', screens);

  const locked = ctx.isLocked(ctx.activeView());
  setText('canvasHint',
    locked ? '● Live — being captured in the browser. Read-only here until sealed.'
      : ctx.state.placeMode ? 'Click on the screenshot to drop a pin.'
        : ctx.options.canPlacePins ? 'Click a pin to read it. Drag to move.'
          : 'Click a pin to read it.');
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

/** Wire the controls both surfaces share: status/category/sort selects (and
 *  one-time category population), the Escape-to-cancel key, and the session
 *  name. All guarded by element presence. */
export function wireControls(ctx) {
  const status = document.getElementById('filterStatus');
  if (status) status.addEventListener('change', (e) => { ctx.state.filters.status = e.target.value; ctx.render(); });

  const category = document.getElementById('filterCategory');
  if (category) {
    for (const c of CATEGORIES) {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c[0].toUpperCase() + c.slice(1);
      category.append(opt);
    }
    category.addEventListener('change', (e) => { ctx.state.filters.category = e.target.value; ctx.render(); });
  }

  const sortBy = document.getElementById('sortBy');
  if (sortBy) sortBy.addEventListener('change', (e) => { ctx.state.filters.sortBy = e.target.value; ctx.render(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (ctx.state.placeMode || ctx.state.composer)) {
      ctx.setState({ placeMode: false, composer: null });
    }
  });

  setText('sessionName', ctx.store.session.name || 'Design QA');
}
