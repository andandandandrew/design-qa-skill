import { el } from '../lib/dom.mjs';
import { clampPct } from '../lib/coords.mjs';
import { openMenu } from './menu.mjs';
import { icon } from './icons.mjs';
import { showToast } from './toast.mjs';

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
    // Feedback-platform: non-text records render their shape as an overlay
    // BENEATH the numbered marker bubble (SVG path for drawings; element box
    // lands in the element POC). The bubble — positioned at the shape centroid —
    // stays the select/focus affordance for every type.
    const shape = buildShapeOverlay(ctx, p);
    if (shape) wrapper.append(shape);
    wrapper.append(buildMarker(ctx, wrapper, p));
  }

  // A click on the image background either drops a pin (place mode) or, failing
  // that, deselects the active comment (closing its canvas card). Clicks on a
  // marker, the composer, or the comment card are ignored here.
  wrapper.addEventListener('click', (e) => {
    if (e.target.closest('.marker') || e.target.closest('.composer') || e.target.closest('.cc-card')) return;
    if (state.placeMode && ctx.options.canPlacePins) {
      const { xPct, yPct } = pointToPct(e, wrapper);
      ctx.setState({ composer: { viewId: view.id, xPct, yPct }, placeMode: false });
      return;
    }
    if (state.activePinId) ctx.setState({ activePinId: null, editing: false });
  });

  if (state.composer && state.composer.viewId === view.id) {
    wrapper.append(buildComposer(ctx, state.composer));
  }

  // Draw mode (Spike 11 on the frozen screenshot): a capture layer collects
  // %-of-image strokes; a required-note composer seals them into a drawing.
  if (state.drawMode && ctx.options.canPlacePins) {
    installDrawLayer(ctx, wrapper, view);
  }

  // Active comment → floating read/edit card beside its marker (DesignOS
  // comment-state cards). Full read + all editing happen here, not the sidebar.
  if (state.activePinId) {
    const active = ctx.visiblePins(view).find((p) => p.id === state.activePinId);
    if (active) wrapper.append(buildCommentCard(ctx, active));
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

// SVGNS — drawings render as a vector path layer over the responsive
// screenshot wrapper. preserveAspectRatio:none + a 0..100 viewBox makes the
// %-coords map straight onto the wrapper at any size; non-scaling-stroke keeps
// the line a constant on-screen weight. Inline-styled so the exported artifact
// renders identically without shipping new CSS.
const SVGNS = 'http://www.w3.org/2000/svg';

/** Per-type shape overlay beneath the marker bubble. null for text pins. */
function buildShapeOverlay(ctx, p) {
  if (p.type === 'drawing' && p.shape?.paths?.length) return buildDrawingSvg(ctx, p);
  if (p.type === 'element' && p.element?.bounds) return buildBoundsBox(ctx, p);
  return null;
}

// Shared %-positioned rectangle primitive: an element selection box (and, later,
// a rect-kind drawing) render through this. Outline + optional name label,
// inline-styled so the artifact renders it without new CSS. Non-interactive —
// the centroid marker bubble owns selection.
function buildBoundsBox(ctx, p) {
  const b = p.element.bounds;
  const resolved = p.status === 'resolved';
  const color = resolved ? 'var(--ink-mid, #8a93a6)' : '#4f8cff';
  const box = el('div', {
    class: `bounds-box ${p.id === ctx.state.activePinId ? 'active' : ''} ${resolved ? 'resolved' : ''}`,
    dataset: { id: p.id },
    style: `position:absolute;left:${b.xPct}%;top:${b.yPct}%;width:${b.wPct}%;height:${b.hPct}%;` +
      `box-sizing:border-box;border:2px solid ${color};background:${resolved ? 'transparent' : 'rgba(79,140,255,.08)'};` +
      'border-radius:4px;pointer-events:none;',
  });
  if (p.element.name) {
    box.append(el('span', {
      style: `position:absolute;top:-18px;left:0;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
        `font-size:10px;line-height:16px;background:${color};color:#fff;padding:0 5px;border-radius:3px;`,
    }, p.element.name));
  }
  return box;
}

function buildDrawingSvg(ctx, p) {
  const resolved = p.status === 'resolved';
  const sh = p.shape;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', `drawing-overlay ${p.id === ctx.state.activePinId ? 'active' : ''} ${resolved ? 'resolved' : ''}`);
  svg.dataset.id = p.id;
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;';
  const stroke = resolved ? 'var(--ink-mid, #8a93a6)' : (sh.color || '#e5484d');
  for (const pts of sh.paths) {
    if (!pts.length) continue;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', 'M ' + pts.map(([x, y]) => `${x} ${y}`).join(' L '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', String(sh.strokeWidth || 3));
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }
  return svg;
}

function buildMarker(ctx, wrapper, p) {
  const { store, state } = ctx;
  const resolved = p.status === 'resolved';
  // Repositioning is a placement op — and only meaningful for a point pin.
  // Non-text records (drawing/element) anchor to a shape, so they're select-
  // only: dragging the centroid bubble would desync it from the ink/box.
  const isPoint = p.type === 'text' || p.type === undefined;
  const movable = ctx.options.canPlacePins && isPoint;
  const m = el('div', {
    class: `marker ${p.id === state.activePinId ? 'active' : ''} ${resolved ? 'resolved' : ''} ${movable ? '' : 'no-move'}`,
    dataset: { id: p.id },
    style: `left:${p.xPct}%;top:${p.yPct}%;`,
  }, [el('span', {}, String(p.index))]);

  // Press → distinguish click (select) from drag (move). Where moving isn't
  // allowed (e.g. the read-only artifact), every press is a plain select.
  m.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    m.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      if (movable && !dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_THRESHOLD) {
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

/**
 * Draw mode over the frozen screenshot. A transparent capture layer collects
 * freehand strokes as %-of-wrapper points (via pointToPct — the same units pins
 * use), previewed live in an SVG ink layer. After the first stroke a required-
 * note composer (anchored at the strokes' bbox centre) seals all strokes into
 * ONE drawing record via store.createDrawing. Strokes live in this closure (not
 * ctx.state), so the imperative live redraw never triggers a clobbering render;
 * commit/cancel ends the mode via setState. Mirrors the live overlay's draw UX.
 */
function installDrawLayer(ctx, wrapper, view) {
  const strokes = [];
  let current = null;
  let composerEl = null;

  const ink = document.createElementNS(SVGNS, 'svg');
  ink.setAttribute('viewBox', '0 0 100 100');
  ink.setAttribute('preserveAspectRatio', 'none');
  ink.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:2;';

  const capture = el('div', { class: 'draw-capture' });
  capture.style.cssText = 'position:absolute;inset:0;cursor:crosshair;z-index:3;touch-action:none;';

  const redraw = () => {
    ink.replaceChildren();
    for (const s of (current ? [...strokes, current] : strokes)) {
      if (!s.length) continue;
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', 'M ' + s.map(([x, y]) => `${x} ${y}`).join(' L '));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#e5484d');
      path.setAttribute('stroke-width', '3');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      ink.appendChild(path);
    }
  };

  capture.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture.setPointerCapture?.(e.pointerId);
    const { xPct, yPct } = pointToPct(e, wrapper);
    current = [[xPct, yPct]];
    redraw();
  });
  capture.addEventListener('pointermove', (e) => {
    if (!current) return;
    const { xPct, yPct } = pointToPct(e, wrapper);
    current.push([xPct, yPct]);
    redraw();
  });
  capture.addEventListener('pointerup', (e) => {
    if (!current) return;
    capture.releasePointerCapture?.(e.pointerId);
    if (current.length >= 2) strokes.push(current); // drop click-not-stroke
    current = null;
    redraw();
    if (strokes.length && !composerEl) openComposer();
  });

  function bboxCenter() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) for (const [x, y] of s) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) return { xPct: 50, yPct: 50 };
    return { xPct: (minX + maxX) / 2, yPct: (minY + maxY) / 2 };
  }

  function openComposer() {
    const c = bboxCenter();
    const input = el('input', { type: 'text', placeholder: 'Add a note for this drawing (required)…' });
    const submit = () => {
      const note = input.value.trim();
      if (!note) return; // note is required — it's what seals the drawing
      ctx.store.createDrawing({ viewId: view.id, paths: strokes, note, author: ctx.state.author })
        .then((pin) => ctx.setState({ drawMode: false, activePinId: pin?.id || null }))
        .catch((err) => { console.warn('design-qa: createDrawing failed', err); ctx.setState({ drawMode: false }); });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); ctx.setState({ drawMode: false }); }
    });
    const send = el('button', { class: 'send', title: 'Save drawing', onclick: submit }, '→');
    composerEl = el('div', { class: 'composer', style: `left:${c.xPct}%;top:${c.yPct}%;z-index:4;` }, [input, send]);
    wrapper.append(composerEl);
    requestAnimationFrame(() => input.focus());
  }

  wrapper.append(ink, capture);
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

// ── Canvas comment card (read / edit) — DesignOS comment-state cards ──────
// Sits beside the active marker. The read card is the default; an explicit
// Edit affordance (the ··· menu) swaps to the edit card. Mirrors the browser
// overlay so authoring and review read identically.

function buildCommentCard(ctx, p) {
  const card = ctx.state.editing ? buildEditCard(ctx, p) : buildReadCard(ctx, p);
  card.style.left = `${p.xPct}%`;
  card.style.top = `${p.yPct}%`;
  // Don't let card interactions bubble to the wrapper (place/deselect).
  card.addEventListener('pointerdown', (e) => e.stopPropagation());
  card.addEventListener('click', (e) => e.stopPropagation());
  return card;
}

function buildReadCard(ctx, p) {
  const { options } = ctx;
  const resolved = p.status === 'resolved';
  const meta = p.category ? ctx.CATEGORY_META[p.category] : null;

  // Header action cluster (DesignOS FxCommentEdit header): ··· (Edit/Delete) ·
  // resolve toggle · close. The ··· only appears if it would hold something.
  const actions = [];
  const menuItems = [
    options.canEditNotes ? { label: 'Edit comment', onClick: () => ctx.setState({ editing: true }) } : null,
    options.canDelete ? {
      label: 'Delete comment', icon: 'trash', danger: true,
      onClick: () => ctx.store.deletePin({ pinId: p.id }).then(() => ctx.setState({ activePinId: null, editing: false })),
    } : null,
  ].filter(Boolean);
  if (menuItems.length) {
    const moreBtn = el('button', { class: 'cc-icon', title: 'More', 'aria-haspopup': 'true' });
    moreBtn.append(icon('more', 15));
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(moreBtn, menuItems, { align: 'right', width: 180 }); });
    actions.push(moreBtn);
  }
  if (options.canResolve) {
    const resolveBtn = el('button', {
      class: `cc-icon cc-resolve ${resolved ? 'on' : ''}`,
      title: resolved ? 'Mark as open' : 'Mark as resolved', 'aria-pressed': String(resolved),
      onclick: (e) => { e.stopPropagation(); toggleResolve(ctx, p, resolved); },
    });
    resolveBtn.append(icon('check', 13, 2.25));
    actions.push(resolveBtn);
  }
  const closeBtn = el('button', { class: 'cc-icon', title: 'Close',
    onclick: (e) => { e.stopPropagation(); ctx.setState({ activePinId: null, editing: false }); } });
  closeBtn.append(icon('close', 14));
  actions.push(closeBtn);

  const head = el('div', { class: 'cc-read-head' }, [
    el('div', { class: 'cc-read-meta' }, [
      el('span', { class: 'cc-author' }, p.author || 'Anonymous'),
      el('span', { class: 'cc-time', title: p.createdAt || '' }, relTime(p.createdAt)),
    ]),
    ...actions,
  ]);

  const body = el('div', { class: 'cc-body' }, p.note || '(no comment)');
  const tagRow = meta
    ? el('div', { class: 'cc-tag-row' }, el('span', { class: 'cc-chip', style: 'cursor:default' }, [
        el('span', { class: 'cc-dot', style: `background:${resolved ? 'var(--ink-mid)' : meta.color}` }),
        meta.label,
      ]))
    : null;
  const main = el('div', { class: 'cc-read-main' }, [body, tagRow].filter(Boolean));

  return el('div', { class: `cc-card cc-read ${resolved ? 'resolved' : ''}`, dataset: { id: p.id } },
    [head, el('div', { class: 'cc-divider' }), main]);
}

function buildEditCard(ctx, p) {
  let draftCategory = p.category || null;

  const ta = el('textarea', { class: 'cc-field', placeholder: 'Add a comment…', rows: '2' });
  ta.value = p.note || '';
  ta.addEventListener('input', () => autoGrow(ta));

  const save = () => ctx.store
    .updatePin({ pinId: p.id, note: ta.value, category: draftCategory ?? null })
    .then(() => ctx.setState({ editing: false }));
  const cancel = () => ctx.setState({ editing: false });

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  const delBtn = el('button', { class: 'cc-icon danger', title: 'Delete' });
  delBtn.append(icon('trash', 14));
  delBtn.addEventListener('click', () => ctx.store.deletePin({ pinId: p.id }).then(() => ctx.setState({ activePinId: null, editing: false })));
  const closeBtn = el('button', { class: 'cc-icon', title: 'Cancel', onclick: cancel });
  closeBtn.append(icon('close', 14));

  const head = el('div', { class: 'cc-edit-head' }, [
    el('span', { class: 'cc-edit-title' }, 'Comment'), delBtn, closeBtn,
  ]);

  const bar = el('div', { class: 'cc-bar' }, [
    buildCatControl(ctx, () => draftCategory, (c) => { draftCategory = c; }),
    el('span', { class: 'cc-spacer' }),
    el('button', { class: 'cc-cancel', onclick: cancel }, 'Cancel'),
    el('button', { class: 'cc-save', onclick: save }, 'Save'),
  ]);
  const inset = el('div', { class: 'cc-inset' }, [ta, bar]);

  const card = el('div', { class: 'cc-card cc-edit', dataset: { id: p.id } },
    [head, el('div', { class: 'cc-divider' }), inset]);
  requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); autoGrow(ta); });
  return card;
}

/** Chip (chosen) / "+ Category" button (invite) + dropdown picker, el-based.
 *  getCat() reads the current key; setCat(keyOrNull) mutates the caller's draft
 *  (persisted on Save). Owns its own open/closed + re-render. */
function buildCatControl(ctx, getCat, setCat) {
  const wrap = el('span', { class: 'cc-cat' });
  let open = false;
  const paint = () => {
    wrap.replaceChildren();
    const key = getCat();
    const meta = key ? ctx.CATEGORY_META[key] : null;
    if (meta) {
      const x = el('span', { class: 'cc-chip-x', title: 'Remove category',
        onclick: (e) => { e.stopPropagation(); setCat(null); open = false; paint(); } }, icon('close', 10));
      wrap.append(el('span', { class: 'cc-chip',
        onclick: (e) => { e.stopPropagation(); open = !open; paint(); } },
        [el('span', { class: 'cc-dot', style: `background:${meta.color}` }), meta.label, x]));
    } else {
      wrap.append(el('span', { class: `cc-add ${open ? 'open' : ''}`,
        onclick: (e) => { e.stopPropagation(); open = !open; paint(); } },
        [icon('plus', 11), 'Category']));
    }
    if (open) {
      wrap.append(el('div', { class: 'cc-picker' }, [
        el('div', { class: 'cc-picker-head' }, 'Category'),
        ...Object.entries(ctx.CATEGORY_META).map(([k, m]) =>
          el('span', { class: `cc-picker-item ${k === key ? 'active' : ''}`,
            onclick: (e) => { e.stopPropagation(); setCat(k); open = false; paint(); } },
            [el('span', { class: 'cc-dot', style: `background:${m.color}` }),
             el('span', { class: 'cc-picker-label' }, m.label),
             k === key ? icon('check', 11) : null].filter(Boolean))),
      ]));
    }
  };
  paint();
  return wrap;
}

function toggleResolve(ctx, p, wasResolved) {
  ctx.store.resolvePin({ pinId: p.id, resolved: !wasResolved, resolvedNote: null });
  if (!wasResolved) {
    showToast('Comment resolved', { undo: () => ctx.store.resolvePin({ pinId: p.id, resolved: false, resolvedNote: null }) });
  }
}

function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`; }

/** "just now" / "5m ago" / "2h ago" / "3d ago" / "May 3". */
function relTime(iso) {
  if (!iso) return 'Just now';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
