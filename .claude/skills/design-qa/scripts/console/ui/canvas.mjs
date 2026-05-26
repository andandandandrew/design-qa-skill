import { el, escapeHtml } from '../lib/dom.mjs';
import { clampPct } from '../lib/coords.mjs';

const DRAG_THRESHOLD = 4; // px before a press becomes a drag rather than a click

/**
 * The pin-on-image editor. Renders the active screen's screenshot with
 * %-positioned markers and handles place / select / drag-move / delete and the
 * deferred-create composer. All persistence goes through ctx.store; geometry is
 * always %-of-image (Spike B), so markers track the image across any resize.
 */
export function renderCanvas(ctx, root) {
  const { store, state } = ctx;
  const view = ctx.activeView();

  // Live-screen ownership (§6): an unsealed browser screen is owned by the
  // capture overlay (px pins on the live DOM). The console shows it locked —
  // it has no %-positioned pins yet and must not be edited from here.
  if (ctx.isLocked(view)) {
    root.classList.remove('placing');
    root.replaceChildren(el('div', { class: 'locked-screen' }, [
      el('div', { class: 'locked-badge' }, 'Live'),
      el('div', { class: 'locked-msg' },
        'This screen is being captured in the browser. Pins are placed in the overlay; ' +
        'it becomes editable here once sealed (navigate away or click Done).'),
    ]));
    return;
  }

  root.classList.toggle('placing', !!state.placeMode);

  if (!view) { root.replaceChildren(el('div', { class: 'empty' }, 'No screen selected.')); return; }
  if (!view.screenshot) {
    root.replaceChildren(el('div', { class: 'no-screenshot' },
      `No screenshot for this screen. ${view.pins.length} pin(s) stored.`));
    return;
  }

  const wrapper = el('div', { class: 'screenshot-wrapper' });
  const img = el('img', { class: 'screenshot', src: store.screenshotUrl(view), alt: view.name });
  wrapper.append(img);

  for (const p of ctx.visiblePins(view)) {
    wrapper.append(buildMarker(ctx, wrapper, p));
  }

  // Place mode: a click on the image drops a pin (opens the composer).
  wrapper.addEventListener('click', (e) => {
    if (!state.placeMode || e.target.closest('.marker') || e.target.closest('.composer')) return;
    const { xPct, yPct } = pointToPct(e, wrapper);
    ctx.setState({ composer: { viewId: view.id, xPct, yPct }, placeMode: false });
  });

  if (state.composer && state.composer.viewId === view.id) {
    wrapper.append(buildComposer(ctx, state.composer));
  }

  root.replaceChildren(wrapper);

  // Scroll the active pin into view + pulse, once the image has size.
  if (state.activePinId) requestAnimationFrame(() => focusMarker(root, state.activePinId));
}

function pointToPct(e, wrapper) {
  const rect = wrapper.getBoundingClientRect();
  return {
    xPct: clampPct(((e.clientX - rect.left) / rect.width) * 100),
    yPct: clampPct(((e.clientY - rect.top) / rect.height) * 100),
  };
}

function buildMarker(ctx, wrapper, p) {
  const { store, state } = ctx;
  const resolved = p.status === 'resolved';
  const m = el('div', {
    class: `marker ${p.id === state.activePinId ? 'active' : ''} ${resolved ? 'resolved' : ''}`,
    dataset: { id: p.id },
    style: `left:${p.xPct}%;top:${p.yPct}%;`,
  }, [el('span', {}, String(p.index))]);

  // Press → distinguish click (select) from drag (move).
  m.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    m.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_THRESHOLD) {
        dragging = true;
        m.classList.add('dragging');
      }
      if (dragging) {
        const { xPct, yPct } = pointToPct(ev, wrapper);
        m.style.left = `${xPct}%`;
        m.style.top = `${yPct}%`;
      }
    };
    const onUp = (ev) => {
      m.releasePointerCapture(e.pointerId);
      m.removeEventListener('pointermove', onMove);
      m.removeEventListener('pointerup', onUp);
      if (dragging) {
        const { xPct, yPct } = pointToPct(ev, wrapper);
        store.movePin({ pinId: p.id, xPct, yPct });
      } else {
        ctx.setState({ activePinId: state.activePinId === p.id ? null : p.id });
      }
    };
    m.addEventListener('pointermove', onMove);
    m.addEventListener('pointerup', onUp);
  });

  return m;
}

function buildComposer(ctx, composer) {
  const input = el('input', { type: 'text', placeholder: 'Add a comment…' });
  const submit = () => {
    ctx.store.createPin({
      viewId: composer.viewId, xPct: composer.xPct, yPct: composer.yPct,
      note: input.value.trim(), author: ctx.state.author,
    }).then((pin) => ctx.setState({ composer: null, activePinId: pin.id }));
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); ctx.setState({ composer: null }); }
  });
  const send = el('button', { class: 'send', title: 'Add comment', onclick: submit }, '→');
  const pill = el('div', { class: 'composer', style: `left:${composer.xPct}%;top:${composer.yPct}%;` },
    [input, send]);
  requestAnimationFrame(() => input.focus());
  return pill;
}

function focusMarker(root, pinId) {
  const marker = root.querySelector(`.marker[data-id="${pinId}"]`);
  if (!marker) return;
  const cRect = root.getBoundingClientRect();
  const mRect = marker.getBoundingClientRect();
  const dx = (mRect.left - cRect.left) - (cRect.width / 2 - mRect.width / 2);
  const dy = (mRect.top - cRect.top) - (cRect.height / 2 - mRect.height / 2);
  root.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
}
