import { el, fmtDate } from '../lib/dom.mjs';
import { icon } from './icons.mjs';
import { openMenu } from './menu.mjs';
import { showToast } from './toast.mjs';

/**
 * Screens list (left sidebar). Click a row to select; a hover `⋯` action opens
 * a DesignOS-style menu (currently just a danger "Delete screen", which removes
 * the screen and all its comments). Honors the left-sidebar search filter.
 * Delete is gated on `store.deleteView` so the read-only artifact never shows it.
 */
export function renderSidebar(ctx, root) {
  const { store, state, options } = ctx;
  const canDelete = typeof store.deleteView === 'function';
  const q = state.screenQuery || '';
  const all = store.session.views;
  const views = q
    ? all.filter((v) => (v.name || '').toLowerCase().includes(q) || (v.url || '').toLowerCase().includes(q))
    : all;

  if (all.length === 0) { root.replaceChildren(el('div', { class: 'empty-note' }, 'No screens yet.')); return; }
  if (views.length === 0) { root.replaceChildren(el('div', { class: 'empty-note' }, 'No screens match your search.')); return; }

  root.replaceChildren(...views.map((v) => {
    const resolved = v.pins.filter((p) => p.status === 'resolved').length;
    const sub = v.source === 'manual' ? 'Uploaded screenshot' : v.url;

    const nameRow = [el('div', { class: 'view-name', title: v.name }, v.name || '(unnamed)')];
    if (canDelete) {
      const actionBtn = el('button', {
        class: 'view-action', title: 'Screen actions', 'aria-haspopup': 'true',
        onclick: (e) => {
          e.stopPropagation();
          openMenu(actionBtn, [
            { label: 'Delete screen', icon: 'trash', danger: true, onClick: () => deleteScreen(ctx, v) },
          ], { align: 'right', width: 180 });
        },
      });
      actionBtn.append(icon('more', 15));
      nameRow.push(actionBtn);
    }

    return el('div', {
      class: `view-item ${v.id === state.activeViewId ? 'active' : ''}`,
      onclick: () => ctx.setState({ activeViewId: v.id, activePinId: null, placeMode: false, composer: null }),
    }, [
      el('div', { class: 'view-row' }, nameRow),
      el('div', { class: 'view-sub', title: sub }, sub),
      el('div', { class: 'view-meta' }, [
        el('span', {}, fmtDate(v.createdAt)),
        el('span', { class: 'pin-count' }, `${resolved}/${v.pins.length}`),
      ]),
    ]);
  }));
}

/** Confirm + delete a screen and all its comments, then keep selection sane. */
async function deleteScreen(ctx, v) {
  const { store, state } = ctx;
  const n = v.pins.length;
  const msg = `Delete "${v.name || 'this screen'}"`
    + (n ? ` and its ${n} comment${n === 1 ? '' : 's'}?` : '?');
  if (!window.confirm(msg)) return;
  try {
    await store.deleteView({ viewId: v.id });
    if (state.activeViewId === v.id) {
      const first = store.session.views[0];
      ctx.setState({ activeViewId: first?.id || null, activePinId: null });
    }
  } catch (err) {
    showToast(`Delete failed: ${err?.message || err}`);
  }
}
