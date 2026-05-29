import { el } from '../lib/dom.mjs';

/**
 * Bottom-centered transient toast with an optional Undo action and a close
 * button. Mirrors Figma's resolve-feedback pattern — one toast at a time
 * (any new call dismisses the prior), auto-dismiss after a short timeout
 * unless the user hovers over it.
 *
 * Usage: `showToast('Comment resolved', { undo: () => store.resolvePin(...) })`
 *
 * Lives in `ui/` so it's available from any pane; the host (app.mjs) doesn't
 * need to mount it — the function lazily creates a `#dqa-toast-host` container
 * the first time it's invoked.
 */

const DISMISS_MS = 6000;
let current = null; // { root, timer }

export function showToast(message, { undo = null, dismissMs = DISMISS_MS } = {}) {
  dismiss();
  const host = ensureHost();

  const root = el('div', { class: 'toast', role: 'status' }, [
    el('span', { class: 'toast-msg' }, message),
    undo ? el('button', {
      class: 'toast-action',
      onclick: () => { try { undo(); } finally { dismiss(); } },
    }, 'Undo') : null,
    el('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: dismiss }, '×'),
  ].filter(Boolean));

  host.appendChild(root);
  // Force a reflow so the entrance transition kicks in.
  // eslint-disable-next-line no-unused-expressions
  root.offsetWidth;
  root.classList.add('in');

  const timer = setTimeout(dismiss, dismissMs);
  // Pause auto-dismiss while the user is over the toast (gives them time to
  // notice Undo without being rushed).
  root.addEventListener('mouseenter', () => clearTimeout(timer));
  current = { root, timer };
}

export function dismiss() {
  if (!current) return;
  clearTimeout(current.timer);
  const { root } = current;
  current = null;
  root.classList.remove('in');
  root.classList.add('out');
  setTimeout(() => { try { root.remove(); } catch {} }, 180);
}

function ensureHost() {
  let host = document.getElementById('dqa-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'dqa-toast-host';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  return host;
}
