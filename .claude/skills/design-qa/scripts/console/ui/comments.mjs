import { el } from '../lib/dom.mjs';
import { showToast } from './toast.mjs';
import { renderStepsDisclosure } from './steps.mjs';

/**
 * Comments panel — the pins of the active screen as Figma-style cards.
 *
 * Layout (matches Figma's comment card; ref `_qa/figma-comment-ui/`):
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ ⓐ                              [cat ▾]  [ ✓ ] │  ← header row
 *   │ #4 · Create Account                           │  ← breadcrumb
 *   │ Andrew Frank · 17h ago                        │  ← byline
 *   │ the character code for the macron "o"         │  ← note body
 *   └───────────────────────────────────────────────┘
 *
 * The avatar is an initial in a deterministic color circle. The "ellipsis"
 * slot from Figma is the **category dropdown** here (per design feedback —
 * a category is the most useful overflow). The circle on the far right is
 * "Mark as resolved": click toggles resolve and shows a bottom toast with
 * Undo — no completion-note prompt (dropped per feedback 2026-05-28).
 *
 * Note editing happens in place (no full re-render mid-typing, so focus is
 * never stolen); commit on blur or Cmd/Ctrl+Enter, cancel on Escape.
 */
export function renderComments(ctx, root) {
  const view = ctx.activeView();
  const pageEl = document.getElementById('commentsPage');

  if (!view) { pageEl.textContent = '—'; root.replaceChildren(); return; }
  pageEl.textContent = view.name;

  // Spike 8 / 9d — recorded-steps disclosure sits above the comment cards. The
  // node returns null if there are no steps AND no preview surface, so the
  // pre-Spike-8 layout is unchanged on legacy / fixture sessions.
  const stepsNode = renderStepsDisclosure(ctx);

  const pins = ctx.visiblePins(view);
  if (pins.length === 0) {
    const total = view.pins.length;
    const empty = el('div', { class: 'empty-note' },
      total === 0 ? 'No pins on this screen yet. Use “+ Add pin”.' : 'No pins match the current filter.');
    root.replaceChildren(...[stepsNode, empty].filter(Boolean));
    return;
  }

  root.replaceChildren(...[stepsNode, ...pins.map((p) => buildCard(ctx, p, view))].filter(Boolean));
}

function buildCard(ctx, p, view) {
  const { store, state, CATEGORIES, options } = ctx;
  const resolved = p.status === 'resolved';
  const authorName = p.author || 'Anonymous';

  // ---- Header: avatar · spacer · category · resolve-button --------------
  const avatar = el('div',
    { class: 'comment-avatar', style: `background:${avatarColor(authorName)}`, title: authorName },
    initialOf(authorName));

  const categoryControl = options.canEditNotes
    ? buildCategorySelect(ctx, p)
    : (p.category ? el('span', { class: 'cat-chip' }, p.category) : null);

  const resolveBtn = options.canResolve
    ? el('button', {
        class: `resolve-btn ${resolved ? 'on' : ''}`,
        title: resolved ? 'Mark as open' : 'Mark as resolved',
        'aria-pressed': String(resolved),
        onclick: (e) => { e.stopPropagation(); toggleResolve(ctx, p); },
      }, checkSvg())
    : null;

  const head = el('div', { class: 'comment-head' }, [
    avatar,
    el('span', { class: 'comment-spacer' }),
    categoryControl,
    resolveBtn,
  ].filter(Boolean));

  // ---- Breadcrumb + byline ---------------------------------------------
  const breadcrumb = el('div', { class: 'comment-breadcrumb' },
    `#${p.index} · ${view.name || '(unnamed screen)'}`);

  const byline = el('div', { class: 'comment-byline' }, [
    el('span', { class: 'comment-author' }, authorName),
    el('span', { class: 'comment-byline-dot' }, ' · '),
    el('span', { class: 'comment-time', title: p.createdAt || '' }, formatRelative(p.createdAt)),
  ]);

  // ---- Note body --------------------------------------------------------
  const noteEl = el('div', { class: `comment-note ${p.note ? '' : 'empty'}` },
    p.note || '(no comment)');
  if (options.canEditNotes) {
    noteEl.addEventListener('click', (e) => { e.stopPropagation(); startNoteEdit(ctx, noteEl, p); });
  }

  // ---- Footer: delete (the only non-header action remaining) -----------
  const children = [head, breadcrumb, byline, noteEl];
  if (options.canDelete) {
    children.push(el('div', { class: 'comment-foot' }, [
      el('span', { class: 'comment-spacer' }),
      el('button', { class: 'icon-btn danger', title: 'Delete pin',
        onclick: (e) => { e.stopPropagation(); store.deletePin({ pinId: p.id }); } }, '🗑'),
    ]));
  }

  return el('div', {
    class: `comment ${p.id === state.activePinId ? 'active' : ''} ${resolved ? 'resolved' : ''}`,
    dataset: { id: p.id },
    onclick: () => ctx.setState({ activePinId: state.activePinId === p.id ? null : p.id }),
  }, children);
}

/**
 * Resolve a comment without any completion-note prompt — Figma-style: a
 * bottom toast confirms the action and offers a one-tap Undo. Unresolving
 * (clicking the filled check again) silently flips status back to open
 * without a toast (the user did it intentionally; no need to confirm).
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

function buildCategorySelect(ctx, p) {
  const { store, CATEGORIES } = ctx;
  // The Figma "ellipsis" slot is the category control here — small,
  // unobtrusive, opens to the standard taxonomy.
  const sel = el('select', {
    class: 'comment-category',
    title: 'Category',
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => {
      e.stopPropagation();
      store.updatePin({ pinId: p.id, category: e.target.value || null });
    },
  }, [
    el('option', { value: '' }, '⋯'),  // empty / no category
    ...ctx.CATEGORIES.map((c) => {
      const o = el('option', { value: c }, c[0].toUpperCase() + c.slice(1));
      if (c === p.category) o.selected = true;
      return o;
    }),
  ]);
  if (p.category) sel.classList.add('has-value');
  return sel;
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

/** First letter of the name (or "?" for anonymous), uppercase. */
function initialOf(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  return s[0].toUpperCase();
}

/**
 * Deterministic background color for the avatar from the author name. Uses a
 * small palette balanced against the Figma-dark theme so initials stay
 * legible in white. djb2-ish hash → palette index.
 */
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

/** Inline SVG check — matches Figma's "Mark as resolved" affordance shape. */
function checkSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3.5 8.5l3 3 6-6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.75');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}
