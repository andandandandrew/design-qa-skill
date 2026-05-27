import { el, escapeHtml, fmtDate } from '../lib/dom.mjs';

/**
 * Comments panel — the pins of the active screen as editable cards.
 * Note editing happens in place (no full re-render mid-typing, so focus is
 * never stolen); commit on blur or Enter, cancel on Escape.
 */
export function renderComments(ctx, root) {
  const { store, state, CATEGORIES } = ctx;
  const view = ctx.activeView();
  const pageEl = document.getElementById('commentsPage');

  if (!view) { pageEl.textContent = '—'; root.replaceChildren(); return; }
  pageEl.textContent = view.name;

  const pins = ctx.visiblePins(view);
  if (pins.length === 0) {
    const total = view.pins.length;
    root.replaceChildren(el('div', { class: 'empty-note' },
      total === 0 ? 'No pins on this screen yet. Use “+ Add pin”.' : 'No pins match the current filter.'));
    return;
  }

  root.replaceChildren(...pins.map((p) => buildCard(ctx, p)));
}

function buildCard(ctx, p) {
  const { store, state, CATEGORIES, options } = ctx;
  const resolved = p.status === 'resolved';

  const noteEl = el('div', { class: `comment-note ${p.note ? '' : 'empty'}` },
    p.note || '(no comment)');
  if (options.canEditNotes) {
    noteEl.addEventListener('click', (e) => { e.stopPropagation(); startNoteEdit(ctx, noteEl, p); });
  }

  // Category: an editable select where notes are editable, a read-only chip
  // (display-only parity) otherwise. Omitted entirely when there's no category.
  const catControl = options.canEditNotes
    ? el('select', { class: 'select', onclick: (e) => e.stopPropagation(),
        onchange: (e) => { e.stopPropagation(); store.updatePin({ pinId: p.id, category: e.target.value || null }); } },
        [el('option', { value: '' }, '— category —'),
         ...CATEGORIES.map((c) => {
           const o = el('option', { value: c }, c[0].toUpperCase() + c.slice(1));
           if (c === p.category) o.selected = true;
           return o;
         })])
    : (p.category ? el('span', { class: 'cat-chip' }, p.category) : null);

  const head = el('div', { class: 'comment-head' }, [
    el('div', { class: 'comment-number' }, String(p.index)),
    el('span', { class: 'comment-author' }, p.author || ''),
    el('span', { class: 'comment-spacer' }),
    catControl,
  ]);

  const children = [head, noteEl];

  if (resolved && p.resolvedNote) {
    children.push(el('div', { class: 'resolved-note' }, `✓ ${p.resolvedNote}`));
  }

  // Footer: resolve toggle (+ optional completion note) and delete, each gated.
  const footChildren = [];
  if (options.canResolve) {
    const resolveToggle = el('label', { class: 'resolve-toggle', onclick: (e) => e.stopPropagation() }, [
      el('input', { type: 'checkbox', onchange: (e) => onResolveToggle(ctx, p, e.target.checked) }),
      resolved ? 'Resolved' : 'Resolve',
    ]);
    if (resolved) resolveToggle.querySelector('input').checked = true;
    footChildren.push(resolveToggle);
  }
  if (options.canDelete) {
    footChildren.push(el('span', { class: 'comment-spacer' }));
    footChildren.push(el('button', { class: 'icon-btn danger', title: 'Delete pin',
      onclick: (e) => { e.stopPropagation(); store.deletePin({ pinId: p.id }); } }, '🗑'));
  }
  if (footChildren.length) children.push(el('div', { class: 'comment-foot' }, footChildren));

  const card = el('div', {
    class: `comment ${p.id === state.activePinId ? 'active' : ''} ${resolved ? 'resolved' : ''}`,
    dataset: { id: p.id },
    onclick: () => ctx.setState({ activePinId: state.activePinId === p.id ? null : p.id }),
  }, children);
  return card;
}

/** Resolving may capture an optional completion note (engineer-side in the
 *  artifact; designer-side in the console). Unchecking clears it. */
function onResolveToggle(ctx, p, checked) {
  let resolvedNote = p.resolvedNote || null;
  if (checked) {
    const entered = window.prompt('Completion note (optional):', resolvedNote || '');
    if (entered === null) { ctx.render(); return; } // cancelled → revert the checkbox
    resolvedNote = entered.trim() || null;
  } else {
    resolvedNote = null;
  }
  ctx.store.resolvePin({ pinId: p.id, resolved: checked, resolvedNote });
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
