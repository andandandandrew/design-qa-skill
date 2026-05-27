/**
 * Drag-to-resize for the left (screens) and right (comments) sidebars.
 * The .body grid uses `var(--col-left) 1fr var(--col-right)`; each handle is an
 * absolutely-positioned strip on the pane boundary that updates its var on drag
 * and persists the widths to localStorage. The canvas (1fr) absorbs the slack.
 */
const MIN = 180, MAX = 560, KEY = '__dqa_cols';

export function setupResizers(body) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  if (saved.left) body.style.setProperty('--col-left', clamp(saved.left) + 'px');
  if (saved.right) body.style.setProperty('--col-right', clamp(saved.right) + 'px');
  makeHandle(body, 'left');
  makeHandle(body, 'right');
}

function clamp(n) { return Math.max(MIN, Math.min(MAX, Number(n) || 0)); }

function persist(body) {
  const read = (v, fb) => parseInt(getComputedStyle(body).getPropertyValue(v), 10) || fb;
  try {
    localStorage.setItem(KEY, JSON.stringify({ left: read('--col-left', 260), right: read('--col-right', 360) }));
  } catch {}
}

function makeHandle(body, side) {
  const h = document.createElement('div');
  h.className = `resizer resizer-${side}`;
  body.appendChild(h);
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    h.classList.add('dragging');
    const rect = body.getBoundingClientRect();
    const onMove = (ev) => {
      const w = clamp(side === 'left' ? ev.clientX - rect.left : rect.right - ev.clientX);
      body.style.setProperty(`--col-${side}`, w + 'px');
    };
    const onUp = () => {
      h.releasePointerCapture(e.pointerId);
      h.classList.remove('dragging');
      h.removeEventListener('pointermove', onMove);
      h.removeEventListener('pointerup', onUp);
      persist(body);
    };
    h.addEventListener('pointermove', onMove);
    h.addEventListener('pointerup', onUp);
  });
}
