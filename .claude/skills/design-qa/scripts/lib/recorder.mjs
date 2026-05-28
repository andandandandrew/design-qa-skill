/**
 * Spike 8 recorder adapter — wraps Playwright's private programmatic Recorder.
 *
 * The internal API used (POC-validated on 1.60.0):
 *   await context._enableRecorder(params, eventSink)
 * with `recorderMode: 'api'` so the recorder runs headless (no Inspector
 * window). The leading-underscore method is not part of Playwright's public
 * surface — the project pins `playwright` to an exact version, and this is the
 * ONE file that imports it. If a future bump moves the API, only this file
 * needs to change.
 *
 * Responsibilities:
 *   - Boot the recorder against the given persistent context.
 *   - Maintain the canonical event log, applying the recorder's actionAdded /
 *     actionUpdated coalescing rule (typing "hello" arrives as N events but the
 *     final form is one `.fill('hello')`).
 *   - Route every event through the redactor BEFORE invoking the caller's
 *     `onEvent` / `onUpdate`. Redaction is a security boundary — callers never
 *     see un-scrubbed event data.
 *
 * Out of scope for 9a (added in later phases):
 *   - Segmentation into `view.steps[]` (9b — `capture.mjs` subscribes here).
 *   - Mark-start boundary (9b/9c — a per-event mark flag managed by the store).
 *   - Node→shadow-DOM "🔴 Recording · N" push (9c).
 *   - Emitters (9e — read from the log produced here).
 *
 * The adapter is intentionally *recorder-aware* but *session-unaware*: it
 * knows about Playwright internals and redaction, nothing about views, pins,
 * or persistence.
 */
import { createRedactor } from './redact.mjs';

/** Per-event shape stored in the log. `pageUrl` is the page URL at action
 *  time (per §13 settled — URL segmentation works from this alone, no CDP). */
const EVENT_KINDS = Object.freeze({ ACTION: 'action', SIGNAL: 'signal' });

/**
 * Selector fragments that mean "this event happened on our own UI, not on
 * something the engineer needs to replay." Dropped at the boundary so the
 * persisted event log + emitted `.spec.ts` never reference them.
 *
 * `__design_qa_host` — our overlay's closed-shadow host id (see
 *   `scripts/overlay/inject.js`). Clicks INSIDE the overlay retarget to this
 *   host because the shadow root is closed, so a single id-match catches
 *   everything: Mark-start chip, popover, comment composer, panel buttons.
 * `x-pw-` — Playwright's in-page recorder UI (glass, tooltip, highlight,
 *   action-point). Most are hidden by the addInitScript stylesheet we ship,
 *   but a stray click on one (e.g. during a teardown frame) shouldn't reach
 *   the persisted log either.
 */
const OVERLAY_SELECTOR_RE = /__design_qa_host|x-pw-/i;

/** True if an `ActionInContext` is on our own UI and should be dropped before
 *  it touches `events[]` or the caller's sinks. Defensive: defaults to KEEP
 *  on missing/odd inputs so a regex change can never lose real recordings. */
export function isOverlayAction(actionData) {
  const sel = actionData?.action?.selector;
  if (typeof sel !== 'string' || sel.length === 0) return false;
  return OVERLAY_SELECTOR_RE.test(sel);
}

/**
 * Attach the programmatic recorder to a persistent Chromium context.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {object} [opts]
 * @param {ReturnType<typeof createRedactor>} [opts.redactor]
 *        Pre-built redactor (e.g. one configured with `redactionPatterns` from
 *        `design-qa.config.json`). If absent, a default redactor is created.
 * @param {(ev: object) => void} [opts.onEvent]
 *        Called once per FRESH event (actionAdded / signalAdded), after scrubbing.
 *        NOT called for `actionUpdated` coalesces — those fire `onUpdate` only.
 *        Dispatch is XOR: every recorder callback hits exactly one of
 *        `onEvent` / `onUpdate`, never both. (Earlier versions called both on
 *        every update, which made a single keystroke materialize as N steps
 *        downstream — capture.mjs would appendStep on `onEvent` *and*
 *        replaceStep on `onUpdate`. Fixed 2026-05-28 from in-browser bug.)
 * @param {(ev: object, prev: object) => void} [opts.onUpdate]
 *        Called when an `actionUpdated` replaces a prior `action` event. `ev`
 *        is the new merged event; `prev` is the one it replaced. Callers use
 *        this to UPDATE an already-persisted step in place rather than append.
 * @param {boolean} [opts.headless=false]
 *        Threaded into the recorder's internal `launchOptions.headless`.
 *        Production capture is headed (the reviewer drives Chromium); the
 *        integration test under `__tests__/` is headless. With `recorderMode:
 *        'api'` no Inspector window is spawned regardless, but the recorder
 *        does read this flag, so pass the value matching the context.
 * @returns {Promise<{
 *   redactor: ReturnType<typeof createRedactor>,
 *   events: Array<object>,
 *   stop: () => void,
 * }>}
 */
export async function attachRecorder(context, opts = {}) {
  const redactor = opts.redactor || createRedactor();
  const onEvent = opts.onEvent || (() => {});
  const onUpdate = opts.onUpdate || (() => {});
  const headless = opts.headless === true;

  /** Canonical event log. Public so 9b can iterate at flush time. */
  const events = [];

  // The recorder may keep firing after the caller has logically "stopped"
  // (we can't unregister the eventSink; only context.close() ends it). This
  // flag lets the caller mute all callbacks without tearing down the context.
  let stopped = false;

  function emit(ev, prev) {
    if (stopped) return;
    // XOR dispatch: an `actionUpdated` is logically "this same step's data got
    // refined" (typing one more character) — NOT a brand-new step. Calling
    // both onUpdate and onEvent here would make capture.mjs both replaceStep
    // and appendStep for every keystroke, producing N steps per fill.
    if (prev) {
      try { onUpdate(ev, prev); } catch (err) { logSinkError(err, 'onUpdate'); }
    } else {
      try { onEvent(ev); } catch (err) { logSinkError(err, 'onEvent'); }
    }
  }

  function safePageUrl(page) {
    try { return page?.url() || ''; } catch { return ''; }
  }

  // The validated params from POC §2. `mode: 'recording'` + `recorderMode: 'api'`
  // is the combination that routes through ProgrammaticRecorderApp (no UI).
  // `handleSIGINT: false` lets our own SIGINT handler stay in charge of
  // graceful shutdown — without it the recorder swallows Ctrl-C.
  await context._enableRecorder(
    {
      language: 'playwright-test',
      launchOptions: { headless },
      contextOptions: {},
      mode: 'recording',
      recorderMode: 'api',
      testIdAttributeName: 'data-testid',
      handleSIGINT: false,
    },
    {
      actionAdded(page, data, code) {
        // Filter at the boundary: clicks/typing on our own overlay host (or a
        // stray Playwright UI element) should not enter the persisted log.
        // Dropping here keeps `events[]` clean, so the actionUpdated "find +
        // replace last action" loop never mistakenly replaces a real action
        // with a follow-up to a dropped overlay action.
        if (isOverlayAction(data)) return;
        const ev = {
          kind: EVENT_KINDS.ACTION,
          t: Date.now(),
          pageUrl: safePageUrl(page),
          data,
          code,
        };
        const added = redactor.maybeRegisterFromAction(data?.action);
        events.push(ev);
        // Order matters: register first (so the new secret is in the map),
        // THEN scrub. If a new secret landed, every previously-stored event
        // must be re-scrubbed — the ariaSnapshot leak-forward problem from
        // the POC means a secret can already be sitting in prior events
        // before its own fill event arrives.
        if (added) redactor.scrubEvents(events);
        else redactor.scrubEvent(ev);
        emit(ev);
      },

      actionUpdated(page, data, code) {
        // Same boundary filter as actionAdded — an update for a dropped
        // overlay action is also unwanted, AND must not touch the prior real
        // action stored in events[]. Drop completely.
        if (isOverlayAction(data)) return;
        // Coalesce: the recorder merges progressive fills/typing into one
        // logical action and re-emits the merged form here. Replace the most
        // recent stored ACTION event (signals interspersed are left in place).
        const ev = {
          kind: EVENT_KINDS.ACTION,
          t: Date.now(),
          pageUrl: safePageUrl(page),
          data,
          code,
        };
        const added = redactor.maybeRegisterFromAction(data?.action);
        let prev = null;
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].kind === EVENT_KINDS.ACTION) {
            prev = events[i];
            events[i] = ev;
            break;
          }
        }
        if (!prev) events.push(ev); // recorder fired update before any add — unlikely but safe
        if (added) redactor.scrubEvents(events);
        else redactor.scrubEvent(ev);
        emit(ev, prev);
      },

      signalAdded(page, data) {
        // Navigation / popup / download signals — no `code` snippet. Useful
        // to 9b as segmentation anchors; we don't filter them here.
        const ev = {
          kind: EVENT_KINDS.SIGNAL,
          t: Date.now(),
          pageUrl: safePageUrl(page),
          data,
          code: '',
        };
        events.push(ev);
        redactor.scrubEvent(ev);
        emit(ev);
      },
    },
  );

  return {
    redactor,
    events,
    /** Mute all caller callbacks. The recorder itself stays alive until the
     *  context closes — that's a Playwright constraint, not a leak. */
    stop() { stopped = true; },
  };
}

/** Surface sink errors loudly. Throwing inside the recorder's eventSink crashes
 *  the recorder thread and stops all further events; swallowing silently makes
 *  9b's segmentation bugs invisible. Log to stderr + tag the callback so they
 *  bubble up in test output / server logs without killing the session. */
function logSinkError(err, label) {
  const msg = err && err.stack ? err.stack : String(err);
  // eslint-disable-next-line no-console
  console.error(`[recorder] ${label} sink threw:`, msg);
}

export { EVENT_KINDS };
