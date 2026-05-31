/**
 * Pin coordinate model — %-of-screenshot at rest (Spike B).
 *
 * A pin's resting position is `xPct, yPct ∈ [0,100]`, relative to the
 * screenshot image's intrinsic dimensions, top-left origin. Rendering is then
 * pure CSS (`left: xPct% ; top: yPct%`) inside a responsive wrapper, so markers
 * follow the image across any resize with no JS.
 *
 * Pure functions, no DOM — usable from Node (fixture generation, Phase 3 store
 * normalization) and from the browser alike.
 */

/** Clamp to the [0,100] percentage range. */
export function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Browser-captured pins are recorded in page-CSS pixels against the live
 * viewport. The screenshot may be taken at a device-pixel-ratio > 1 and as a
 * full-page capture (taller than the viewport). Convert to %-of-image using the
 * same math the artifact builder has used at export time:
 *
 *   dpr          = shotWidth / viewportWidth
 *   docHeightCss = shotHeight / dpr
 *   xPct         = x / viewportWidth  * 100
 *   yPct         = y / docHeightCss   * 100
 */
export function pagePxToPct({ x, y, viewportWidth, shotWidth, shotHeight }) {
  const dpr = shotWidth && viewportWidth ? shotWidth / viewportWidth : 1;
  const docHeightCss = dpr ? shotHeight / dpr : shotHeight;
  return {
    xPct: clampPct(viewportWidth ? (x / viewportWidth) * 100 : 0),
    yPct: clampPct(docHeightCss ? (y / docHeightCss) * 100 : 0),
  };
}

/**
 * Manual uploads have no page — the image is the only coordinate space. A click
 * at (clickX, clickY) over an image rendered at (renderedWidth, renderedHeight)
 * maps directly to a percentage, independent of the image's intrinsic size.
 */
export function imagePxToPct({ clickX, clickY, renderedWidth, renderedHeight }) {
  return {
    xPct: clampPct(renderedWidth ? (clickX / renderedWidth) * 100 : 0),
    yPct: clampPct(renderedHeight ? (clickY / renderedHeight) * 100 : 0),
  };
}

/**
 * Element-box (Spike 12) → %-at-rest. Normalize BOTH page-px corners through
 * pagePxToPct (so wPct/hPct share the pin denominators exactly), yielding a
 * %-rect that renders as an outline over the responsive screenshot.
 * (Intentional duplicate of lib/coords.mjs boxToPct — buildless, no shared
 * bundle; change both copies together.)
 */
export function boxToPct({ x, y, w, h, viewportWidth, shotWidth, shotHeight }) {
  const tl = pagePxToPct({ x, y, viewportWidth, shotWidth, shotHeight });
  const br = pagePxToPct({ x: x + w, y: y + h, viewportWidth, shotWidth, shotHeight });
  return {
    xPct: tl.xPct,
    yPct: tl.yPct,
    wPct: clampPct(br.xPct - tl.xPct),
    hPct: clampPct(br.yPct - tl.yPct),
  };
}

/**
 * Read PNG intrinsic dimensions from a buffer without decoding the image.
 * PNG: 8-byte signature, 4-byte IHDR length, 4-byte "IHDR", then width (BE u32)
 * at byte 16 and height (BE u32) at byte 20.
 */
export function pngDimensions(buf) {
  if (!buf || buf.length < 24) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
