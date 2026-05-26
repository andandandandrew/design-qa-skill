/**
 * Pin coordinate model — %-of-screenshot at rest (Spike B), node side.
 *
 * Intentional small duplicate of console/lib/coords.mjs: the console copy is
 * served to the browser from the console/ root, this copy runs in the daemon /
 * migration. Keeping them separate avoids a build step (buildless constraint).
 * If you change the conversion, change both.
 */

export function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Page-CSS-pixel pin → %-of-image, using the same math the artifact builder
 * has always used at export:
 *   dpr          = shotWidth / viewportWidth
 *   docHeightCss = shotHeight / dpr
 *   xPct = x / viewportWidth * 100 ; yPct = y / docHeightCss * 100
 */
export function pagePxToPct({ x, y, viewportWidth, shotWidth, shotHeight }) {
  const dpr = shotWidth && viewportWidth ? shotWidth / viewportWidth : 1;
  const docHeightCss = dpr ? shotHeight / dpr : shotHeight;
  return {
    xPct: clampPct(viewportWidth ? (x / viewportWidth) * 100 : 0),
    yPct: clampPct(docHeightCss ? (y / docHeightCss) * 100 : 0),
  };
}

/** PNG intrinsic dimensions without decoding (width@16, height@20, BE u32). */
export function pngDimensions(buf) {
  if (!buf || buf.length < 24) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
