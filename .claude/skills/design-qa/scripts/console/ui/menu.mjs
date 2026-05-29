/**
 * Floating dropdown menu — the DesignOS `Menu`/`MenuItem` pattern
 * (clusters.jsx / app-frame.jsx FileMenu): a `--surface-overlay` sheet with
 * `--r-4` corners, `--shadow-3` + an inset hairline, 26px items that hover to
 * `--surface-4` (danger items hover to `--danger-tint`), separators, and an
 * optional eyebrow header. One menu open at a time; closes on outside-click,
 * Esc, or item activation.
 *
 * items: [{ label, onClick, icon, danger, checked } | { separator:true }
 *         | { header:'…' }]
 */
import { el } from '../lib/dom.mjs';
import { icon as glyph } from './icons.mjs';

let current = null;

export function closeMenu() {
  if (!current) return;
  current.remove();
  current = null;
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('mousedown', onDocDown, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('blur', closeMenu);
}

function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }
function onDocDown(e) { if (current && !current.contains(e.target)) closeMenu(); }

export function openMenu(anchorEl, items, { align = 'left', width = 200 } = {}) {
  closeMenu();
  const menu = el('div', { class: 'os-menu', style: `width:${width}px`, role: 'menu' },
    items.filter(Boolean).map((it) => {
      if (it.separator) return el('div', { class: 'os-menu-sep' });
      if (it.header) return el('div', { class: 'os-menu-header eyebrow' }, it.header);
      const kids = [];
      if (it.icon) kids.push(el('span', { class: 'os-menu-ic' }, glyph(it.icon, 13)));
      kids.push(el('span', { class: 'os-menu-label' }, it.label));
      if (it.checked) kids.push(el('span', { class: 'os-menu-check' }, glyph('check', 12)));
      return el('div', {
        class: `os-menu-item${it.danger ? ' danger' : ''}`,
        role: 'menuitem',
        onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); },
      }, kids);
    }));

  document.body.appendChild(menu); // append first so offsetWidth/Height are real
  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4); // flip above
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  current = menu;
  // Defer listener attach so the opening click doesn't immediately close it.
  setTimeout(() => {
    if (!current) return;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
  }, 0);
  return menu;
}
