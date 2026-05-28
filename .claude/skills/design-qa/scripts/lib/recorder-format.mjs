/**
 * Recorder action → human text. Used by:
 *   - lib/capture.mjs to populate the Recording-popover step list (9c).
 *   - lib/emit-steps.mjs to produce `recording-steps.md` (9e).
 *   - The console's Preview-spec modal step list (9d).
 *
 * Pure — no Playwright dependency, no fs. Operates on the recorder's
 * `ActionInContext.action` shape: `{ name, selector, text|value, url, key,
 * options, … }`. The selector is a Playwright internal locator string
 * (`internal:role=button[name="Save"]`, `internal:label="Email"`, etc.); we
 * extract a human label from the most common semantic forms and fall back to
 * the raw selector for CSS/XPath.
 *
 * Bold markers use Markdown `**` — both the popover (which strips them) and
 * `recording-steps.md` (which renders them) can consume the same string.
 */

/** Human-readable description of one structured recorder action. */
export function describeAction(action) {
  const a = action || {};
  const label = a.selector ? selectorLabel(a.selector) : '';
  switch (a.name) {
    case 'openPage':
    case 'navigate':
      return `Go to \`${a.url || ''}\``;
    case 'click':
      return `Click ${label || 'an element'}`;
    case 'dblclick':
      return `Double-click ${label || 'an element'}`;
    case 'fill':
      return `Type \`${a.text ?? a.value ?? ''}\` into ${label || 'an input'}`;
    case 'press':
      return `Press \`${a.key || ''}\``;
    case 'select':
      return `Pick \`${(a.options || a.value || []).toString()}\` from ${label || 'a dropdown'}`;
    case 'check':
      return `Check ${label || 'the box'}`;
    case 'uncheck':
      return `Uncheck ${label || 'the box'}`;
    case 'closesPage':
      return 'Close the page';
    case 'setInputFiles':
      return `Upload file(s) into ${label || 'an input'}`;
    default:
      return a.name ? `_(${a.name})_` : '_(unknown action)_';
  }
}

/**
 * Extract a human label from a Playwright locator string. Recognizes the
 * common semantic forms — getByRole / getByLabel / getByText / getByPlaceholder
 * / getByTestId — and falls back to the raw selector (truncated) for CSS/XPath.
 *
 * Bold markdown on the inner label so step lists read like prose:
 *   `the **Save** button`  vs.  `the Save button`
 */
export function selectorLabel(selector) {
  if (!selector) return '';
  let m;
  m = /internal:role=([a-z]+)\[name="((?:[^"\\]|\\.)*)"/i.exec(selector);
  if (m) return `the **${m[2]}** ${m[1]}`;
  m = /internal:role=([a-z]+)/i.exec(selector);
  if (m) return `a **${m[1]}**`;
  m = /internal:label="((?:[^"\\]|\\.)*)"/i.exec(selector);
  if (m) return `the **${m[1]}** field`;
  m = /internal:text="((?:[^"\\]|\\.)*)"/i.exec(selector);
  if (m) return `**${m[1]}**`;
  m = /internal:testid=\[data-testid=["']?([^\]"']+)/i.exec(selector);
  if (m) return `the **${m[1]}** element`;
  m = /internal:attr=\[placeholder=["']?([^\]"']+)/i.exec(selector);
  if (m) return `the **${m[1]}** field`;
  return `\`${selector.length > 60 ? selector.slice(0, 57) + '…' : selector}\``;
}
