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
  const { store, state, CATEGORIES } = ctx;
  const resolved = p.status === 'resolved';

  const noteEl = el('div', { class: `comment-note ${p.note ? '' : 'empty'}` },
    p.note || '(no comment)');
  noteEl.addEventListener('click', (e) => {
    e.stopPropagation();
    startNoteEdit(ctx, noteEl, p);
  });

  const catSel = el('select', { class: 'select', onclick: (e) => e.stopPropagation(),
    onchange: (e) => { e.stopPropagation(); store.updatePin({ pinId: p.id, category: e.target.value || null }); } },
    [el('option', { value: '' }, '— category —'),
     ...CATEGORIES.map((c) => {
       const o = el('option', { value: c }, c[0].toUpperCase() + c.slice(1));
       if (c === p.category) o.selected = true;
       return o;
     })]);

  const resolveToggle = el('label', { class: 'resolve-toggle', onclick: (e) => e.stopPropagation() }, [
    el('input', { type: 'checkbox', onchange: (e) =>
      store.resolvePin({ pinId: p.id, resolved: e.target.checked, resolvedNote: p.resolvedNote }) }),
    resolved ? 'Resolved' : 'Resolve',
  ]);
  if (resolved) resolveToggle.querySelector('input').checked = true;

  const del = el('button', { class: 'icon-btn danger', title: 'Delete pin',
    onclick: (e) => { e.stopPropagation(); store.deletePin({ pinId: p.id }); } }, '🗑');

  const children = [
    el('div', { class: 'comment-head' }, [
      el('div', { class: 'comment-number' }, String(p.index)),
      el('span', { class: 'comment-author' }, p.author || ''),
      el('span', { class: 'comment-spacer' }),
      catSel,
    ]),
    noteEl,
  ];

  if (resolved && p.resolvedNote) {
    children.push(el('div', { class: 'resolved-note' }, `✓ ${p.resolvedNote}`));
  }
  children.push(el('div', { class: 'comment-foot' }, [resolveToggle, el('span', { class: 'comment-spacer' }), del]));

  const card = el('div', {
    class: `comment ${p.id === state.activePinId ? 'active' : ''} ${resolved ? 'resolved' : ''}`,
    dataset: { id: p.id },
    onclick: () => ctx.setState({ activePinId: state.activePinId === p.id ? null : p.id }),
  }, children);
  return card;
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
