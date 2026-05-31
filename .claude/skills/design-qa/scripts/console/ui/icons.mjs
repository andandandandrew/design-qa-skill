/**
 * Iconography — synced with DesignOS, which renders the **lucide** glyph set by
 * name (src/icons.jsx maps `comment→MessageSquare`, `search→Search`,
 * `trash→Trash2`, `more→MoreHorizontal`, `sparkles→Sparkles`, …). DesignOS
 * pulls lucide's UMD from a CDN; our console is buildless and the exported
 * artifact runs from `file://`, so we inline the exact lucide path data instead
 * of taking a CDN/runtime dependency. Same glyphs, offline-safe.
 *
 * Stroke conventions match lucide / the DesignOS `--icon-stroke` default (1.8,
 * round caps/joins). `icon()` returns an <svg> element; `iconHTML()` returns the
 * markup string (for the static index.html / artifact template).
 */

// lucide 0.469 inner markup, keyed by the DesignOS icon name.
const GLYPHS = {
  search:   '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus:     '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus:    '<path d="M5 12h14"/>',
  close:    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check:    '<path d="M20 6 9 17l-5-5"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight:'<path d="m9 18 6-6-6-6"/>',
  chevUp:   '<path d="m18 15-6-6-6 6"/>',
  comment:  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  pencil:   '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  more:     '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  trash:    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  filter:   '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
};

export const ICON_NAMES = Object.keys(GLYPHS);

const NS = 'http://www.w3.org/2000/svg';

/** Return an <svg> element for `name`. Inherits color via `currentColor`. */
export function icon(name, size = 16, strokeWidth = 1.8) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = GLYPHS[name] || '';
  return svg;
}

/** Markup string variant for static templates (index.html / artifact head). */
export function iconHTML(name, size = 16, strokeWidth = 1.8) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name] || ''}</svg>`;
}
