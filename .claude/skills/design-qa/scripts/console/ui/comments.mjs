import { el } from '../lib/dom.mjs';
import { showToast } from './toast.mjs';
import { icon } from './icons.mjs';
import { openMenu } from './menu.mjs';
import { renderStepsTab } from './steps.mjs';

/**
 * Right pane — two tabs (Comments | Steps). The Comments tab renders the active
 * screen's pins as DesignOS comment cards; the Steps tab renders the recorded
 * Playwright steps. Tab state lives on ctx.state.rightTab.
 *
 * Comment card matches DesignOS `comments-panel.jsx` `CommentCard`: a 24px
 * avatar on the LEFT, a body column on the right (breadcrumb `#n · screen`,
 * author + relative time, note body, optional category foot-tag), and
 * hover/selected reveals top-right actions — a `⋯` overflow menu (category +
 * delete) and the circular resolve check. No persistent borders (flat list).
 */
export function renderComments(ctx, root) {
  const view = ctx.activeView();
  const tab = ctx.state.rightTab || 'comments';

  // Tab active states + comment-only search-row visibility.
  document.getElementById('tabComments')?.classList.toggle('active', tab === 'comments');
  document.getElementById('tabSteps')?.classList.toggle('active', tab === 'steps');
  const searchRow = document.getElementById('commentsSearchRow');
  if (searchRow) searchRow.hidden = tab !== 'comments';

  const scopeEl = document.getElementById('commentsPage');
  if (scopeEl) scopeEl.textContent = view ? (view.name || '(unnamed screen)') : '—';

  if (!view) { root.replaceChildren(); return; }

  if (tab === 'steps') { root.replaceChildren(...renderStepsTab(ctx, view)); return; }

  const pins = ctx.visiblePins(view);
  if (pins.length === 0) {
    const total = view.pins.length;
    root.replaceChildren(el('div', { class: 'empty-note' },
      total === 0 ? 'No comments on this screen yet.' : 'No comments match the current filter.'));
    return;
  }
  root.replaceChildren(...pins.map((p) => buildCard(ctx, p, view)));
}

function buildCard(ctx, p, view) {
  const { store, state, options } = ctx;
  const resolved = p.status === 'resolved';
  const authorName = p.author || 'Anonymous';

  // ── Avatar (left column) ──
  const avatar = el('div',
    { class: 'comment-avatar', style: `background:${avatarColor(authorName)}`, title: authorName },
    initialOf(authorName));

  // ── Body column ──
  const crumb = el('div', { class: 'comment-crumb' }, [
    el('span', { class: 'comment-crumb-n' }, `#${p.index}`),
    ' · ',
    el('span', { class: 'comment-crumb-screen' }, view.name || '(unnamed screen)'),
  ]);
  const byline = el('div', { class: 'comment-byline' }, [
    el('span', { class: 'comment-author' }, authorName),
    el('span', { class: 'comment-time', title: p.createdAt || '' }, ` ${formatRelative(p.createdAt)}`),
  ]);
  const noteEl = el('div', { class: `comment-note ${p.note ? '' : 'empty'}` }, p.note || '(no comment)');
  if (options.canEditNotes) {
    noteEl.addEventListener('click', (e) => { e.stopPropagation(); startNoteEdit(ctx, noteEl, p); });
  }

  const bodyKids = [crumb, byline, noteEl];
  if (p.category) bodyKids.push(buildCategoryTag(p.category));
  const body = el('div', { class: 'comment-body' }, bodyKids);

  // ── Top-right actions (revealed on hover / when selected) ──
  const actions = [];
  const moreItems = buildMoreItems(ctx, p);
  if (moreItems.length) {
    const moreBtn = el('button', { class: 'comment-act', title: 'More', 'aria-haspopup': 'true',
      onclick: (e) => { e.stopPropagation(); openMenu(moreBtn, moreItems, { align: 'right', width: 200 }); } });
    moreBtn.append(icon('more', 15));
    actions.push(moreBtn);
  }
  if (options.canResolve) {
    const resolveBtn = el('button', {
      class: `resolve-btn ${resolved ? 'on' : ''}`,
      title: resolved ? 'Mark as open' : 'Mark as resolved',
      'aria-pressed': String(resolved),
      onclick: (e) => { e.stopPropagation(); toggleResolve(ctx, p); },
    });
    resolveBtn.append(icon('check', 13, 2.25));
    actions.push(resolveBtn);
  }
  const actionsWrap = actions.length ? el('div', { class: 'comment-actions' }, actions) : null;

  return el('div', {
    class: `comment ${p.id === state.activePinId ? 'active' : ''} ${resolved ? 'resolved' : ''}`,
    dataset: { id: p.id },
    onclick: () => ctx.setState({ activePinId: state.activePinId === p.id ? null : p.id }),
  }, [avatar, body, actionsWrap].filter(Boolean));
}

/** The `⋯` menu items for a card: category picker (+ clear) and delete. Each
 *  gated by the surface's options, so the read-only artifact shows nothing. */
function buildMoreItems(ctx, p) {
  const { store, CATEGORIES, options } = ctx;
  const items = [];
  if (options.canEditNotes) {
    items.push({ header: 'Category' });
    for (const c of CATEGORIES) {
      items.push({ label: cap(c), checked: p.category === c, onClick: () => store.updatePin({ pinId: p.id, category: c }) });
    }
    if (p.category) items.push({ label: 'Clear category', onClick: () => store.updatePin({ pinId: p.id, category: null }) });
  }
  if (options.canDelete) {
    if (items.length) items.push({ separator: true });
    items.push({ label: 'Delete comment', icon: 'trash', danger: true, onClick: () => store.deletePin({ pinId: p.id }) });
  }
  return items;
}

/** DesignOS CommentTag — a small surface-3 foot chip with a category dot. */
const CATEGORY_COLORS = {
  spacing: 'var(--accent)', color: 'var(--component)', text: 'var(--warning)',
  interaction: 'var(--success)', 'code-pattern': 'var(--ink-mid)', component: 'var(--component)',
  workflow: 'var(--accent-hi)', page: 'var(--ink-lo)',
};
function buildCategoryTag(category) {
  return el('span', { class: 'comment-tag' }, [
    el('span', { class: 'comment-tag-dot', style: `background:${CATEGORY_COLORS[category] || 'var(--ink-mid)'}` }),
    cap(category),
  ]);
}

/**
 * Resolve without a completion-note prompt — a bottom toast confirms + offers
 * Undo. Unresolving (clicking the filled check again) is silent.
 */
function toggleResolve(ctx, p) {
  const wasResolved = p.status === 'resolved';
  ctx.store.resolvePin({ pinId: p.id, resolved: !wasResolved, resolvedNote: null });
  if (!wasResolved) {
    showToast('Comment resolved', {
      undo: () => ctx.store.resolvePin({ pinId: p.id, resolved: false, resolvedNote: null }),
    });
  }
}

function startNoteEdit(ctx, noteEl, p) {
  const ta = el('textarea', { class: 'comment-note-edit' });
  ta.value = p.note || '';
  ta.addEventListener('click', (e) => e.stopPropagation());
  let done = false;
  const commit = () => { if (done) return; done = true; ctx.store.updatePin({ pinId: p.id, note: ta.value }); };
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); }
    else if (e.key === 'Escape') { done = true; ctx.render(); }
  });
  noteEl.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ---- Tiny presentation helpers ------------------------------------------

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function initialOf(name) {
  const s = String(name || '').trim();
  return s ? s[0].toUpperCase() : '?';
}

/** Deterministic avatar background from the author name (data identity, not
 *  chrome — kept distinct so multiple authors read apart). djb2 → palette. */
const AVATAR_PALETTE = [
  '#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ab',
];
function avatarColor(name) {
  const s = String(name || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

/** "5m ago" / "2h ago" / "3d ago" / "May 3" — short relative timestamp. */
function formatRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
