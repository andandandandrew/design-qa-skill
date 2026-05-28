/**
 * Console-side mirror of `scripts/lib/recorder-format.mjs`. Intentional
 * duplicate (same pattern as `console/lib/coords.mjs` mirroring `lib/coords.mjs`):
 * the buildless console can't import from outside its own static dir, and the
 * formatter is small enough that copying beats wiring an HTTP route or a build
 * step. If the regex set or output style changes in the Node-side module,
 * mirror the change here.
 *
 * Used by the Steps disclosure (`ui/steps.mjs`) and the Preview-spec modal
 * (`ui/preview-spec.mjs`) to render step labels. Keep in sync with the live
 * Node formatter that drives the capture-overlay popover.
 */

/** Human-readable description of one recorder action. */
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
