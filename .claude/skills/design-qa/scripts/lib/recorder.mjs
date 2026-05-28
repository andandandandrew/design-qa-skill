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
 * Attach the programmatic recorder to a persistent Chromium context.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {object} [opts]
 * @param {ReturnType<typeof createRedactor>} [opts.redactor]
 *        Pre-built redactor (e.g. one configured with `redactionPatterns` from
 *        `design-qa.config.json`). If absent, a default redactor is created.
 * @param {(ev: object) => void} [opts.onEvent]
 *        Called once per finalized event (action OR signal), AFTER scrubbing.
 *        For `actionUpdated` coalescing this fires AGAIN with the merged form;
 *        the prior `actionAdded` callback is superseded (see `onUpdate`).
 * @param {(ev: object, prev: object) => void} [opts.onUpdate]
 *        Optional. Called when an `actionUpdated` replaces a prior `action`
 *        event — useful for 9b's segmentation if it needs to know about the
 *        coalesce. `ev` is the new merged event; `prev` is the one it replaced.
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
    if (prev) {
      try { onUpdate(ev, prev); } catch (err) { logSinkError(err, 'onUpdate'); }
    }
    try { onEvent(ev); } catch (err) { logSinkError(err, 'onEvent'); }
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
