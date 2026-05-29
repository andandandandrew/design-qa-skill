import { el, escapeHtml, fmtDate } from '../lib/dom.mjs';

/** Screens list. Click selects a screen; pin-count badge reflects live state. */
export function renderSidebar(ctx, root) {
  const { store, state } = ctx;
  root.replaceChildren(...store.session.views.map((v) => {
    const resolved = v.pins.filter((p) => p.status === 'resolved').length;
    const sub = v.source === 'manual' ? 'Uploaded screenshot' : v.url;
    return el('div', {
      class: `view-item ${v.id === state.activeViewId ? 'active' : ''}`,
      onclick: () => ctx.setState({ activeViewId: v.id, activePinId: null, placeMode: false, composer: null }),
    }, [
      el('div', { class: 'view-name', title: v.name }, v.name || '(unnamed)'),
      el('div', { class: 'view-sub', title: sub }, sub),
      el('div', { class: 'view-meta' }, [
        el('span', { class: 'mono' }, fmtDate(v.createdAt)),
        el('span', { class: 'pin-count' }, `${resolved}/${v.pins.length}`),
      ]),
    ]);
  }));
  if (store.session.views.length === 0) {
    root.replaceChildren(el('div', { class: 'empty-note' }, 'No screens yet.'));
  }
}
