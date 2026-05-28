/**
 * Capture-time secrets redaction for the interaction recorder (Spike 8).
 *
 * The Playwright recorder serializes raw `fill()` values into THREE places
 * per event: `action.text` (the typed value), the `.ts` `code` snippet, and
 * the `ariaSnapshot` ARIA-tree string. `ariaSnapshot` lists every visible
 * input's CURRENT value, so a password typed at step 3 keeps reappearing in
 * every subsequent event's snapshot — fill values bleed forward, not just
 * backward. All three places need scrubbing, and a new secret needs to scrub
 * BOTH the current event AND every previously-stored one.
 *
 * The redactor is per-recording (rebuilt at each `attachRecorder` call); it
 * does not bleed across sessions. The defaults below are what the smoke test
 * validates; projects can additively widen via `redactionPatterns` in
 * `design-qa.config.json` (threaded in by 9b's capture wiring).
 *
 * This is a SECURITY BOUNDARY, not a polish module — it MUST land in the
 * same phase as the recorder adapter. See architecture_decisions memory.
 */

/** Field-name regex applied to the `name="…"` clause inside an internal
 *  selector. Covers the most common credential / PII labels. */
const DEFAULT_PATTERN = /password|pwd|secret|token|api[ _-]?key|otp|2fa|cvv|ssn|credit[ _-]?card/i;

/** Single-character keys cause string-allocation explosion via collisions
 *  (registering `'S'` and `split('S').join('[REDACTED]')` blows up V8 — caught
 *  in smoke). 4 is empirically safe and well below any real credential. */
const MIN_SECRET_LEN = 4;

/** Pull the `name="…"` out of an internal selector. The captured form survives
 *  embedded escapes well enough for our regex matching; we're not parsing it. */
function nameFromSelector(selector) {
  const m = /\[name="((?:[^"\\]|\\.)*)"/i.exec(selector || '');
  return m ? m[1] : '';
}

/** Compile a string or RegExp pattern into a case-insensitive RegExp. */
function compilePattern(p) {
  if (p instanceof RegExp) return new RegExp(p.source, p.flags.includes('i') ? p.flags : p.flags + 'i');
  return new RegExp(String(p), 'i');
}

/**
 * Build a fresh redactor for one recording. Returns an opaque object the
 * recorder adapter drives. Pure — no side effects until `register` / `scrub`
 * are called.
 *
 * @param {object} [opts]
 * @param {Array<string|RegExp>} [opts.extraPatterns]  Additive to DEFAULT_PATTERN.
 */
export function createRedactor({ extraPatterns = [] } = {}) {
  const patterns = [DEFAULT_PATTERN, ...extraPatterns.map(compilePattern)];
  /** Map<rawValue, envVarName> — one entry per distinct secret encountered. */
  const map = new Map();

  function matchesAnyPattern(name) {
    return patterns.some((re) => re.test(name));
  }

  function envVarFor(fieldName) {
    const slug = String(fieldName || 'FIELD')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'FIELD';
    const base = `DESIGN_QA_FIELD_${slug}`;
    // Different `raw` values that normalize to the same slug get suffixed
    // (_2, _3, …) so each secret maps to a distinct env var.
    const taken = new Set(map.values());
    if (!taken.has(base)) return base;
    let i = 2;
    let candidate = `${base}_${i}`;
    while (taken.has(candidate)) candidate = `${base}_${++i}`;
    return candidate;
  }

  /**
   * Inspect a single `fill` action and, if its selector's `name` matches a
   * redaction pattern, register the typed value. Handles prefix-collapse: the
   * recorder fires progressive `actionUpdated` events as the user types
   * (`'S'` → `'SE'` → `'SEC'` → …), so when a new value extends an existing
   * registered key (or vice versa), the shorter one is dropped and the map
   * converges on the final full value only.
   *
   * @returns true if a new secret was registered (caller should `scrubEvents`
   *          retroactively over the stored event log).
   */
  function maybeRegisterFromAction(action) {
    if (!action || action.name !== 'fill') return false;
    const fieldName = nameFromSelector(action.selector);
    if (!fieldName || !matchesAnyPattern(fieldName)) return false;
    const raw = action.text ?? action.value ?? '';
    if (typeof raw !== 'string' || raw.length < MIN_SECRET_LEN) return false;
    if (map.has(raw)) return false;
    for (const existing of [...map.keys()]) {
      if (raw.startsWith(existing) || existing.startsWith(raw)) map.delete(existing);
    }
    map.set(raw, envVarFor(fieldName));
    return true;
  }

  /**
   * Deep-walk `v` and replace every registered secret with its env-var form.
   * Strings get TWO substitution shapes:
   *   1. Quoted (`'pw'` or `"pw"`) → `process.env.DESIGN_QA_FIELD_PASSWORD ?? ''`
   *      so the emitted `.ts` stays syntactically valid.
   *   2. Bare occurrence (in `action.text`, `ariaSnapshot`, human step text) →
   *      `[REDACTED DESIGN_QA_FIELD_PASSWORD]` so the leak is visible and
   *      labeled instead of silently disappearing.
   * Arrays and plain objects are walked recursively. Other types (numbers,
   * booleans, null, Date, etc.) pass through unchanged.
   */
  function scrubValue(v) {
    if (v == null) return v;
    if (typeof v === 'string') {
      let out = v;
      for (const [raw, envVar] of map) {
        if (!raw) continue;
        out = out.split(`'${raw}'`).join(`process.env.${envVar} ?? ''`);
        out = out.split(`"${raw}"`).join(`process.env.${envVar} ?? ''`);
        out = out.split(raw).join(`[REDACTED ${envVar}]`);
      }
      return out;
    }
    if (Array.isArray(v)) return v.map(scrubValue);
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = scrubValue(v[k]);
      return out;
    }
    return v;
  }

  /**
   * Scrub `code` and `data` on a single event in place, returning the event.
   * Caller decides whether the event is a `{ kind, data, code, … }` recorder
   * event or any other object with those fields.
   */
  function scrubEvent(ev) {
    if (!ev || typeof ev !== 'object') return ev;
    if (ev.code !== undefined) ev.code = scrubValue(ev.code);
    if (ev.data !== undefined) ev.data = scrubValue(ev.data);
    return ev;
  }

  /** Scrub every event in `events` in place. Cheap to re-run; idempotent. */
  function scrubEvents(events) {
    if (!Array.isArray(events)) return;
    for (const ev of events) scrubEvent(ev);
  }

  /** Distinct env-var names emitted so far — for the `[Preview spec]` modal's
   *  redaction-count chip (9d) and the `.spec.ts` header comment (9e). */
  function getEnvVars() {
    return [...new Set(map.values())];
  }

  return {
    maybeRegisterFromAction,
    scrubValue,
    scrubEvent,
    scrubEvents,
    getEnvVars,
    get count() { return map.size; },
  };
}

// Exported for tests + future hardening that may inspect the defaults directly.
export const REDACT_DEFAULTS = Object.freeze({
  pattern: DEFAULT_PATTERN,
  minSecretLen: MIN_SECRET_LEN,
});
