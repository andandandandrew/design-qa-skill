# Design QA — Interaction recording & replay (Spike 8)

**Status:** Design pass complete + mechanism validated by throwaway POC (2026-05-28).
Phasing is the next ask. See `## POC results` below for what changed against the
original analysis.
**Bundle slot:** already reserved — see Phase-7 zip `README.md`.

---

## 1. The problem (restated, narrow)

A QA reviewer drops a pin saying "this error state is wrong." The screenshot
captures *what* they saw; it does not capture *how they got there.* An engineer
opening the artifact a day later can't reliably reproduce a state that
depends on form input, multi-step navigation, or filter selection.

Goal: while the reviewer naturally drives the headed Chromium we already
launch, **also record the path they took to reach the annotated state**, and
emit it as both:

- (a) an **executable Playwright spec** the engineer can run (`npx playwright test the-script.spec.ts`); and
- (b) a **human-followable step list** the engineer can read and reproduce by hand.

Both forms travel inside the existing Phase-7 zip bundle, alongside
`artifact.html`, `session.json`, and `screenshots/`. The bundle's
`README.md` already advertises the slot.

This is a "high blast radius" workstream — it touches the capture overlay,
the session schema, the export bundle, and adds a new surface in the
console. Per project working style we are writing this doc, getting
sign-off, and *then* phasing.

---

## POC results (2026-05-28)

Throwaway script at `.claude/skills/design-qa/scripts/spike8-poc.mjs` (not
shipped). Real-app run against an Auth0-protected target. Headless smoke at
`spike8-smoke.mjs`. Findings landed in the order they were discovered:

**SETTLED — no remaining unknowns:**

1. **Mechanism import path works on shipped Playwright (1.60.0).** `context._enableRecorder(params, eventSink)` with `recorderMode: 'api'` is reachable, structured `actionAdded(page, data, code)` events fire, **no Inspector window opens**. Mechanism risk in `## 2. Mechanism — recommendation` is downgraded — pin + adapter-wrap remain right, but treat them as boilerplate hygiene, not real risk.
2. **Selector quality is excellent on a real app.** 5/5 captured actions on the Auth0 flow used `getByRole` with semantic name attributes (`'Email address'`, `'Password'`, `'Continue'`). The "robustness rules" in `## 3. Granularity` hold without modification.
3. **URL segmentation works via per-event `pageUrl` capture alone.** Did not need to subscribe to CDP `Page.frameNavigated` — the recorder's per-action page reference is enough to draw segment dividers in the linear view.
4. **Replay round-trip is sound IF an implicit `goto` runs before step 1.** The reviewer was already on the auth page when they pressed Mark-start, so the first recorded action was a `click`, not a `goto` — replay starting at `about:blank` had no page to act against. Fix in POC: synthesize an implicit `await page.goto(firstAction.pageUrl)` when the recorded path doesn't open with a navigation.

**🚨 SECURITY FINDING (not anticipated by the doc; now resolved):**

The recorder serializes raw fill values into **three** places per event — `action.text`, the `.ts` `code` snippet, AND the `ariaSnapshot` ARIA-tree string (which lists every visible input's current value, so a password typed at step 3 still appears in every snapshot from step 4 onward). The Auth0 POC run captured the reviewer's actual password verbatim into all of them.

§4 originally treated auth as "the engineer's problem" (no `storageState` shipping, etc.). That handled tokens. **It did not handle the more immediate leak vector: the reviewer typing credentials into the live form while the recorder is on.** Even if the reviewer presses Mark-start *after* login, preconditions get serialized too. This made redaction a **security boundary**, not a polish item — must land in the same phase as the recorder adapter, not later. See revised `## 4. Auth & preconditions` for the layered policy that was added, and below for the validated algorithm.

**Validated redaction algorithm (smoke-tested headlessly, then deployed in the live POC):**

- Heuristic: at every fill, check `selector` name against `/password|pwd|secret|token|api[ _-]?key|otp|2fa|cvv|ssn|credit[ _-]?card/i`. Match → register the typed value in a per-recording redaction map.
- **Minimum length 4 characters.** Single-char keys collide with normal text in selectors/snapshots (e.g. registering `'S'` and then `.split('S').join('[REDACTED]')` exploded V8 string allocation — caught in smoke).
- **Prefix-collapse.** The recorder fires progressive `actionUpdated` events as the user types (`'S'` → `'SE'` → `'SEC'` → …). When a new value extends an existing registered key (or vice versa), drop the shorter; the map converges on the final full value only.
- **Forward + retroactive scrub.** Each new event is scrubbed before storage; when a new secret lands, every previously-captured event is re-scrubbed in place (because that secret may have appeared in their ariaSnapshot already).
- **Substitution form.** In `code`: `'<value>'` → `process.env.<NAME> ?? ''`. In bare strings (action.text, ariaSnapshot, step text): `<value>` → `[REDACTED <NAME>]`. Env-var name: `DESIGN_QA_FIELD_<UPPER_SNAKE_FIELDNAME>` (deduplicated with `_2`, `_3` on collision).
- **Per-recording, not per-session.** Map is rebuilt at each capture start; secrets don't bleed across sessions.

Smoke result: 7 captured events, 1 secret registered, 0 leaks of the fake password value in any field of any event after scrubbing (including the ariaSnapshot of a Sign-in click that fired *after* the password fill).

**Other surfaced details worth recording:**

- The recorder's `actionUpdated` merging behavior coalesces consecutive fills (typing "hello" arrives as 5 events but the final form is one `.fill('hello')`). The POC handles this by replacing the most-recent action on every `actionUpdated`.
- The recorder reports password inputs as `role=textbox`, not `role=password`. DOM `type="password"` is NOT surfaced in the structured action data. The heuristic name-match is currently the only signal; a future hardening pass could query the live DOM at fill-time for `input.type`.
- Auto-replay against a fresh headless context **will fail at the login wall** for any authenticated target. This is the *correct* outcome — confirms the §4 "engineer handles auth" position. Replay should only be expected to succeed on apps where the recorded path doesn't cross an auth boundary, or where the engineer has wired their own login fixture.

---

## 2. Mechanism — recommendation

**Embed Playwright's programmatic Recorder** into the existing
`launchPersistentContext` in `lib/capture.mjs`, **complemented by a thin CDP
listener for URL-boundary segmentation.** Skip Playwright tracing (only sees
Playwright API calls, not human clicks). Skip rrweb (wrong output shape — DOM
mutations, not runnable code).

### Why the programmatic Recorder

The Recorder is what `playwright codegen` uses under the hood. Run in
"programmatic" mode (no Inspector window), it injects an in-page script that
observes real user clicks/inputs/keypresses and emits a stream of structured
`ActionInContext` events on the `BrowserContext`. For every action it produces
*both* a parsed JSON event *and* the corresponding `.ts` snippet — exactly the
dual output we need, free of charge. Its selector engine produces
`getByRole('button', { name: 'Save' })`-quality locators with ambiguity
resolution, far better than anything we'd write ourselves over `event.target`.

### What the Recorder doesn't do well, and the CDP supplement

The Recorder is weak on **scrolls**, **hovers**, and (importantly for us)
doesn't expose a clean event for **navigation start**. We need
URL-segmentation — each sealed screen carries the slice of actions that
produced it — so we attach a CDP session per page and subscribe to
`Page.frameNavigated`. The CDP listener is ~30 lines and only marks segment
boundaries; it does *not* try to capture clicks (that's the Recorder's job).

### Risk to record up-front

The programmatic Recorder API is **internal** — `context._enableRecorder` is
private (leading underscore), not part of the public API surface. **POC
downgrade (2026-05-28):** mechanism risk turned out smaller than feared —
worked first try on Playwright 1.60.0 with no Inspector window. Treat the
mitigations below as boilerplate hygiene, not real risk.

1. **Pin the Playwright version** in `package.json` (currently floats; we'll
   lock to whatever ships when this lands).
2. **Wrap the import behind a single `lib/recorder.mjs` adapter** so a future
   Playwright upgrade breaks one file, not the whole capture path.

If the internal API moves and the upgrade cost ever exceeds the value, the
fallback is a hand-rolled `addInitScript` + `exposeBinding` capture against
the same `click`/`input`/`change`/`scroll` events, with our own getByRole
heuristic. That's a worse output but a sealed exit ramp.

The exact private API the adapter wraps (verified by POC):

```js
await context._enableRecorder(
  {
    language: 'playwright-test',
    launchOptions: { headless: false },
    contextOptions: {},
    mode: 'recording',
    recorderMode: 'api',          // <-- routes through ProgrammaticRecorderApp,
    testIdAttributeName: 'data-testid',
    handleSIGINT: false,
  },
  {
    actionAdded(page, data, code)   { /* data = ActionInContext, code = .ts snippet */ },
    actionUpdated(page, data, code) { /* progressive merging — replace prior action */ },
    signalAdded(page, data)         { /* navigation/popup/download — no code */ },
  },
);
```

### Sources

- Playwright codegen — https://playwright.dev/docs/codegen
- Tracing API (rejected) — https://playwright.dev/docs/api/class-tracing
- CDP session — https://playwright.dev/docs/api/class-cdpsession
- Internal recorder shape — `microsoft/playwright` `packages/playwright-core/src/server/recorder.ts`
- rrweb (rejected) — https://github.com/rrweb-io/rrweb

---

## 3. Granularity — what events the recording captures

The Recorder gives us all of these for free; the design call is what we
**emit** in each form.

| Event              | In `.ts` spec | In human step list                 |
| ------------------ | ------------- | ---------------------------------- |
| navigation         | `page.goto`   | "Go to https://…/orders/123"       |
| click              | `locator.click()` | "Click the **Save** button"     |
| fill / type        | `locator.fill('…')` | "Type **42** into Quantity"   |
| select option      | `locator.selectOption('…')` | "Pick **Pending** from Status" |
| check / uncheck    | `locator.check()` | "Check the **Remember me** box" |
| keypress (Enter, Esc, Tab, arrows) | `page.keyboard.press('Enter')` | "Press Enter" |
| scroll (only if it changes the screen) | `locator.scrollIntoViewIfNeeded()` | omitted from step list |
| hover (only before a click on a hover-revealed element) | merged into next click | omitted from step list |
| drag                                                  | `dragTo()` | "Drag **X** onto **Y**" |

**Excluded** from both forms (too brittle / noisy):

- Pure mouse movement, raw `pointermove`
- Inter-keystroke timing
- Scrolls that don't change what's on screen at the moment of a subsequent action
- Focus-only events with no resulting action

**Robustness rules** (encoded in the emitter, applied to every action):

1. Locators emit `getByRole`/`getByLabel`/`getByText` over CSS paths whenever the
   Recorder offers them; we do not "improve" them.
2. Consecutive `fill`s on the same input collapse to one — typing "hello" is one
   step, not five.
3. Waits are **implicit** — Playwright auto-waits for actionability. We do not
   emit `waitForTimeout`. If a script flakes for engineers, that's a real signal
   that the page needs a stable assertion, not a sleep.
4. Each segment ends with `await expect(page).toHaveURL(/…/)` — the next-screen
   URL — so a failing replay reports "didn't reach the expected screen" rather
   than crashing on the next action's locator.

---

## 4. Auth & preconditions — the hard one

**Two distinct problems, layered solution. The POC surfaced the second one;
the original doc only addressed the first.**

The persistent profile under `.designqa/<sessionDir>/browser-profile/` carries
the QA reviewer's cookies. An engineer pulling the bundle does NOT inherit
those cookies, and we shouldn't ship them (auth tokens, session cookies, and
PII). So a recorded `page.goto('https://app.example.com/orders/123')` followed
by `getByRole('button', { name: 'Save' }).click()` will land the engineer on
a login wall, and the recorded selectors won't match.

**But there's a second, more immediate leak:** while the recorder is on, *any*
`fill()` action — including the reviewer typing their password into the live
login form — captures the raw value into `action.text`, the `.ts` `code`
string, AND the `ariaSnapshot` ARIA-tree (which lists every visible input's
current value, so the password keeps appearing in every subsequent action's
snapshot). The POC ran against an Auth0-protected app and the reviewer's real
password landed in plaintext across all four output files. This is solved
*at capture time*, not at export, and it's a security boundary, not a polish
item.

### Layer 1 (security): redaction at capture time

Validated by POC. See `## POC results` for the full algorithm and smoke
test. Summary:

- Heuristic name-match against `/password|pwd|secret|token|api[ _-]?key|otp|2fa|cvv|ssn|credit[ _-]?card/i` on the selector's `name="…"`.
- Min length 4 chars (single-char keys collide with normal text).
- Prefix-collapse for progressive `actionUpdated` events.
- Forward + retroactive scrub on every new secret (covers ariaSnapshot leak vector).
- Substitution: `.fill('<value>')` → `.fill(process.env.DESIGN_QA_FIELD_PASSWORD ?? '')`; bare strings → `[REDACTED DESIGN_QA_FIELD_PASSWORD]`.
- Per-recording redaction map; does not bleed across sessions.

The heuristic will miss inputs with non-obvious labels (a generic `"Confirm"`
field used for a token, say). Two future hardening options, neither in v1:

1. **Type-attribute query at fill time** — synchronously interrogate the page
   DOM for `input.type === 'password'` regardless of label.
2. **Project-configurable patterns** — `design-qa.config.json` exposes a
   `redactionPatterns: []` array merged with the defaults. Off by default;
   on for projects with stricter compliance.

False-positive risk (a normal field whose name *contains* `"password"` —
"reset password helper"-style copy) is acceptable; the cost of a false
redaction is the engineer setting an env var that doesn't matter, vs. the
cost of a false negative which is a credential leak.

### Layer 2 (portability): the Mark-start preconditions split

Three options were on the table. The recommendation:

### Recommended: a `// PRECONDITION` block emitted at the top of the spec, plus a written precondition in the step list

The Recorder doesn't know what's "auth" and what's "step 1." Neither does any
heuristic — login flows look like any other form fill. So we don't try to be
clever. We give the reviewer a **single explicit affordance** in the capture
overlay — a "Mark start of feedback" button — and treat everything *before*
that click as preconditions, everything *after* as the recorded path. The
emitted spec scaffolds a preconditions block the engineer fills in:

```ts
test('Reproduce: Orders → Edit → Save (broken validation)', async ({ page }) => {
  // === PRECONDITION (set this up however your project handles auth) ===
  // The reviewer was already logged in when they started recording.
  // Replace this block with your own login, fixture load, or storageState.
  await page.goto('https://app.example.com/login');
  // await page.getByLabel('Email').fill('you@example.com');
  // await page.getByLabel('Password').fill('…');
  // await page.getByRole('button', { name: 'Sign in' }).click();

  // === RECORDED PATH (everything below was captured) ===
  await page.goto('https://app.example.com/orders/123');
  await page.getByRole('button', { name: 'Edit' }).click();
  // … etc
});
```

And in the step list:

```
PRECONDITIONS
  • Log in as the user who recorded this (the reviewer was already
    logged in when they started). The recording does not include
    login steps.

STEPS
  1. Go to https://app.example.com/orders/123
  2. Click the Edit button
  3. …
```

We do **not** ship a Playwright `storageState` JSON. It carries live
session cookies; we're not in the business of distributing those. The
engineer's project will already have a login fixture, an `.env`, or
storageState handling — we route them to it with a clear comment.

### Rejected alternatives

- **Env-injected creds the bundle reads** — fragile across projects with
  different auth flows; a security smell.
- **Record login too** — looks fine in the moment, but the recorded login
  selectors mix with the recorded *feedback* steps and the engineer can't
  tell where one ends and the other begins. The "Mark start" affordance is
  what makes that boundary explicit.
- **Re-run with the QA reviewer's profile attached** — that's the bundle
  *not* being portable, which defeats the point.

The reviewer marks the start once at the beginning of a session. If they
forget, "Mark start" stays visible at all times in the verb bar; the next
click on it retroactively trims everything before to preconditions. (No
"reset" — they can re-mark, which moves the boundary forward.)

**POC refinement (2026-05-28):** the original doc framed Mark-start as a
security boundary ("press it AFTER you're logged in"). In practice the POC
user pressed `m` *before* logging in — the natural workflow is "open
Chromium → mark → start doing things." This put the login flow in the
recorded *path*, which would have been a credential leak without Layer 1
redaction. With redaction in place, the position weakens to a **presentation
convenience, not a safety property**: secrets are scrubbed regardless of
which side of the boundary they land. "Press Mark-start before the bug
demonstration begins" is now the only guidance the UX needs to give.

---

## 5. Per-screen segmentation

Today a session has `views[]`; each view (= screen) is one URL × one captured
state with N pins. After Spike 8, **each view carries the slice of recorded
actions that produced it**:

```diff
  view {
    id, source, url, name, viewport,
    screenshot, createdAt, sealedAt,
    pins: [...],
+   steps: [
+     { id, kind: 'goto'|'click'|'fill'|'select'|'check'|'press'|'drag',
+       selector, text, value, ts, code },
+     ...
+   ],
  }
```

Segmentation rule, encoded in the recorder adapter:

1. While the reviewer is on URL `A` with an unsealed view, every recorded
   action appends to that view's `steps[]`.
2. On `Page.frameNavigated` to URL `B`, the *navigation action itself* closes
   view `A`'s segment, the existing seal logic in `capture.mjs` runs (taking
   the screenshot, % normalizing pins, etc.), and view `B`'s segment opens
   with the navigation as its first step.
3. The "Save" verb (explicit seal-in-place) closes the current segment without
   opening a new one. Next pin on the same URL starts a fresh view *and* a
   fresh segment.
4. The "New" verb (save + start new on same URL) closes the current segment
   and immediately opens the next one with a synthetic `// fresh capture on
   same URL` marker — no recorded action, just a structural divider.

Steps placed *before* "Mark start of feedback" are emitted into the
preconditions block, not into any view's `steps[]`.

Engineer-facing artifact: each pin's card in the console gets a small
"How I got here" disclosure that expands to show the human step list for
that view. The bundle's exported `recording.spec.ts` is the union of all
views' steps in order, with `// --- view: <name> ---` separators.

---

## 6. UX — capture overlay (Playwright Chromium)

Today's verb bar (Phase 6):

```
┌──────────────────────────────────────┐
│ 💬 Comment   ✓ Save   ＋ New      ▾  │
└──────────────────────────────────────┘
```

After Spike 8 — one new state-aware verb, one indicator dot:

```
┌─────────────────────────────────────────────────────┐
│ 💬 Comment   ✓ Save   ＋ New   ⏺ Mark start      ▾  │
└─────────────────────────────────────────────────────┘
        (resting — nothing recorded yet)

┌─────────────────────────────────────────────────────┐
│ 💬 Comment   ✓ Save   ＋ New   🔴 Recording · 7  ▾  │
└─────────────────────────────────────────────────────┘
        (active — 7 actions captured since Mark start)
```

Click behavior:

- **⏺ Mark start** (resting): collapses everything previously recorded into
  preconditions, starts a clean recording, button morphs to the red active
  state.
- **🔴 Recording · N** (active): clicking opens a small popover —
  "Captured 7 steps. [View steps] [Reset start here] [Stop recording]."

The recorder is **on from the moment Chromium launches**; "Mark start" only
controls the preconditions / steps boundary. This is deliberate: we never
want to lose the first action because the reviewer hadn't pressed Record
yet, and "everything before Mark start is preconditions" is the explicit
contract.

The View-steps popover (shown above the verb bar so it doesn't bake into
screenshots — already shadow-DOM):

```
┌──────────────────────────────────────────┐
│ Recording                            ×   │
│ Started 0:02:14 ago · 7 steps captured   │
│ ──────────────────────────────────────── │
│  1. Go to /orders/123                    │
│  2. Click "Edit"                         │
│  3. Type "42" into Quantity              │
│  4. Click "Save"                         │
│  5. Wait for /orders/123/saved           │
│  …                                       │
│ ──────────────────────────────────────── │
│ [Reset start here]  [Stop recording]     │
└──────────────────────────────────────────┘
```

"Stop recording" exists for the rare case the reviewer wants to do
something off-script (admin task, log into a different account) without
contaminating the recording. Resumes with a fresh `Mark start`.

**Browser-close behavior:** unchanged from today — `finalizeActiveViews`
seals every unsealed view. The recorder flushes any in-flight segment to
that view's `steps[]` before the seal completes (the existing seal awaits
the recorder flush; we add `await recorder.flush(viewId)` next to
`flushScreenshot(viewId)` in `capture.mjs`).

**Gotcha already known (preserve):** native `confirm`/`alert`/`prompt` are
auto-dismissed inside the Playwright context. The View-steps popover uses
shadow-DOM UI for everything (same pattern as Save's confirm bar).

---

## 7. UX — console

The console is the **authoring surface for the recording**, not just a
viewer. The reviewer should be able to:

- See what was captured per screen, and re-arrange it within the bounds of
  what was actually recorded (you can't add fictional steps);
- **Delete** any step that's noise (a misclick they backed out of);
- **Edit** any step's human-readable text (the `.ts` code stays
  authoritative; the human-readable text is just for the step list);
- **Preview** the emitted `.ts` spec before exporting.

### Where it lives

Each screen's comment-card list already has a heading row with screen
name + pin count. Add a **"Steps (N)"** disclosure between the screen
heading and the comment list:

```
┌─────────────────────────────────────────────────────────────────┐
│  Orders detail · /orders/123                            [⋯]      │
│  ▸ Steps (7)                          [Preview spec]            │
│ ─────────────────────────────────────────────────────────────── │
│  #1  A          Andrew · 2m ago                          ⋯  ◯   │
│      The Save button doesn't disable while pending             │
│                                                                 │
│  #2  A          Andrew · 1m ago                          ⋯  ◯   │
│      Error toast position is wrong                              │
└─────────────────────────────────────────────────────────────────┘
```

Expanded (`▾ Steps (7)`):

```
┌─────────────────────────────────────────────────────────────────┐
│  Orders detail · /orders/123                            [⋯]      │
│  ▾ Steps (7)                          [Preview spec]            │
│ ─────────────────────────────────────────────────────────────── │
│   ⋮  1. Go to /orders/123                            [edit] [×] │
│   ⋮  2. Click "Edit"                                 [edit] [×] │
│   ⋮  3. Type "42" into Quantity                      [edit] [×] │
│   ⋮  4. Click "Save"                                 [edit] [×] │
│   ⋮  5. Wait for URL /orders/123/saved               [edit] [×] │
│   ⋮  6. Click the error toast                        [edit] [×] │
│   ⋮  7. Click "Dismiss"                              [edit] [×] │
│ ─────────────────────────────────────────────────────────────── │
│  #1 …                                                           │
└─────────────────────────────────────────────────────────────────┘
```

- The `⋮` handle is **disabled in v1** — reordering is risky because the
  recorded selectors assume order-of-operations (e.g. you can't click Save
  before you've typed). Surfaced as a future affordance only if users ask.
  Delete and edit-text are non-controversial.
- `[edit]` opens an inline single-line input for the human step's text.
  The underlying action JSON is unchanged.
- `[×]` removes the step from emission. (We keep the action in `steps[]`
  with `omitted: true` so a future revert is possible without re-recording.
  Hidden from emitted spec + step list.)
- `[Preview spec]` opens a modal showing the would-be-exported
  `recording.spec.ts` as syntax-highlighted text, with copy-to-clipboard.

### Lookback parity

Per the Phase-6 "lookback is fully editable" rule, everything above works
identically in lookback mode (`?session=<basename>`). No new gates.

### Surfaces this does **not** touch

- The pin card itself is unchanged.
- The canvas / screenshot is unchanged.
- The Share dialog is unchanged — the recording flows into the existing
  bundle slot, no new chooser option.

---

## 8. Bundle output

The Phase-7 bundle adds two files at the root, alongside `artifact.html`:

```
my-session.zip
├── artifact.html              ← unchanged
├── session.json               ← unchanged (now includes views[].steps[])
├── screenshots/               ← unchanged
├── recording.spec.ts          ← NEW — runnable Playwright spec
├── recording-steps.md         ← NEW — human-readable step list
└── README.md                  ← UPDATED — Spike-8 slot no longer "future"
```

`recording.spec.ts` is one Playwright `test()` per session (not per view —
the whole path is one reproducible scenario). View boundaries become `//
--- view: <name> ---` comments.

`recording-steps.md` is the same content the console "View steps" popover
shows, plus the precondition block.

The single-file (non-bundle) Share option does **not** include the
recording — the recording is fundamentally a multi-file artifact and
shouldn't get mangled into an inlined `.html`. The Share dialog's
"Share as single file" sub-text gets a small "(no replay script)" note;
"Share as bundle (zip)" sub-text mentions "+ replay script."

The silent `<sessionDir>/exports/<HHMMSS>-vN/` archive mirrors the bundle
shape, including the two new files.

---

## 9. Schema migration

`SCHEMA_VERSION` bumps 3 → 4. `migrateDoc()` additively backfills
`view.steps = []` on any v3 doc — same idempotent additive pattern as the
v2 (`xPct`/`yPct`) and v3 (`author`/`project`/`stack`/`captureMode`)
migrations. No data loss.

The doc-level `session.recordingStartAt` (timestamp of the most recent
"Mark start") moves with the migration: if absent, all existing steps are
treated as preconditions on the next export (i.e. a doc upgraded mid-
session emits an empty path, not a wrong one). Reviewer presses "Mark
start" once to begin emission.

---

## 10. Things deliberately **out of scope** for this spike

- **Spike 9 (post-change regression diff)** depends on this spike landing,
  but is its own design pass — research-only, multi-mechanism
  (visual/structural/LLM-judged) comparison; do not pre-commit. We are
  *not* building anything to support Spike 9 yet beyond having a portable
  recording.
- **Step reordering** in the console — flagged §6 as disabled v1.
- **Multi-tab recording** — `launchPersistentContext` does support multiple
  tabs today; the recorder will see them. We seal per-page and per-URL
  already. Cross-tab assertions ("then in tab B…") are not in scope; the
  emitted spec serializes everything into the page that received the
  action.
- **Mobile / touch / device-emulation** — manual upload remains the answer.

---

## 11. Open questions for sign-off (not blocking the doc, but worth flagging)

1. **"Mark start" default — RESOLVED (2026-05-28).** With Layer-1 redaction
   in place, Mark-start became a presentation convenience, not a security
   boundary. Recommendation locks in: explicit Mark-start; recorder always
   on from launch; if unset by the time the reviewer ends, the entire
   stream is "the path" (POC default) — *not* "everything is preconditions"
   (original doc default), which would have left the bundle empty. See
   `## 4. Auth & preconditions` Layer 2.
2. **`recording.spec.ts` runnable as `playwright test` directly, or as a
   plain script `node recording.mjs`?** The doc assumes `.spec.ts` because
   engineers most often want `npx playwright test`; but a plain script
   removes any framework dependency. Recommendation: `.spec.ts` —
   engineers without Playwright installed get a clear error to install it,
   not a half-working bare script. **Still open.**
3. **Recorder version pinning** — locked to the Playwright version
   shipped at landing time. POC confirmed working on 1.60.0. **Still open
   on whether to bump first.**

### Newly opened by the POC

4. **Redaction false-negatives on non-obvious field labels.** The heuristic
   covers names matching the regex; an input labeled `"Confirm"` used for a
   token would slip through. Open question is whether v1 ships the
   heuristic alone or also a DOM `input.type === 'password'` query at
   fill-time (more robust, slightly heavier).
5. **Project-configurable redaction patterns** — should
   `design-qa.config.json` expose `redactionPatterns: []`? Defaults handle
   typical web apps; stricter compliance projects may want additions. Lean
   "yes, but optional with sensible defaults" for v1.
6. **`[Preview spec]` modal should surface redaction state.** When the
   reviewer opens the preview in the console (`## 7. UX — console`), the
   modal should show "X values redacted" prominently so they can confirm
   nothing sensitive slipped through before sharing. Add to the §7 mock.

---

## 12. What the next code phase looks like (for orientation only — not the
plan)

Once this doc is signed off, a phased plan covering:

- A. Recorder adapter (`scripts/lib/recorder.mjs` — wraps the internal
  Recorder import, exposes `start(context)` → an event stream).
- B. Schema v4 + migration + segment-on-seal wiring in `session.mjs` and
  `capture.mjs`.
- C. Capture-overlay verb-bar additions (Mark start + indicator + popover).
- D. Console "Steps (N)" disclosure + per-step edit/delete + Preview-spec
  modal.
- E. Emitters (`recording.spec.ts` + `recording-steps.md`) wired into
  `exportSession()` and the on-the-fly zip.

…would be phases 9a–9e on `v2-enhancements`.

---

## 13. Planning entry — now-known / still-open / newly-open

Use this as the starting artifact for the next session's planning pass.

### Now-known (settled — phase plan can rely on these)

- Mechanism: `context._enableRecorder(params, eventSink)` with `recorderMode: 'api'`. Works on Playwright 1.60.0. No Inspector window.
- Selector quality: getByRole + semantic name on real Auth0 form (5/5).
- URL segmentation: per-event `pageUrl` is sufficient; no CDP `frameNavigated` subscription needed.
- Granularity coverage observed in practice: `click`, `fill`, `openPage`. Other kinds (`select`, `check`, `press`, `dblclick`, `closesPage`, `setInputFiles`) are modeled in the POC's emitter and replay but not yet exercised on a real app.
- Secret redaction: heuristic name-match + min-length + prefix-collapse + forward/retroactive scrub. 0 leaks of 1 password across 7 events (smoke). Substitution form locked in (`process.env.DESIGN_QA_FIELD_<NAME>`).
- Replay needs implicit `goto`: if the first recorded action isn't `openPage`/`navigate`, replay must `await page.goto(firstAction.pageUrl)` before step 1.
- The "Mark start" UX position weakens to a presentation convenience now that redaction is unconditional. Recorder is always on from launch.

### Still-open from the original doc

- `.spec.ts` (Playwright Test) vs. plain `recording.mjs` (no framework dep) for the runnable form. Recommendation: `.spec.ts`. Sign-off pending.
- Playwright version pin choice (1.60.0 now; bump first or land on it?).
- Step reordering in the console — currently disabled v1; re-confirm before phasing.
- Multi-tab recording — out of scope; confirm.

### Newly-open from the POC

- Redaction false-negatives on non-obvious field labels (Open question #4 above) — heuristic alone in v1, or also DOM `input.type` query?
- Project-configurable `redactionPatterns` in `design-qa.config.json` (Open question #5) — yes/no for v1?
- `[Preview spec]` modal should show "X values redacted" (Open question #6) — add to §7 UX mock?
- The capture overlay's "🔴 Recording · N" indicator (per §6) needs a binding mechanism from Node → shadow-DOM overlay. POC used stdin; production needs the equivalent of `__designQA_setRecorderState({active, count})`. Design pass on the Node→shadow side of the binding.
- Bundle integration: production must write `recording.spec.ts` + `recording-steps.md` into the Phase-7 zip on Share, with redaction applied. The on-the-fly `zip` spawn already adds files; the emitter wires in next to it.

### Phased build orientation (carried from §12, restated with POC findings folded in)

Likely phases on `v2-enhancements`, after sign-off in the next session:

- **9a. Recorder adapter + redaction module.** Pin Playwright, add `scripts/lib/recorder.mjs` wrapping `_enableRecorder`. Add `scripts/lib/redact.mjs` with the validated algorithm + the redaction smoke ported under `scripts/lib/__tests__/` as a permanent regression. Both LAND TOGETHER — redaction is a security boundary, can't ship the recorder without it.
- **9b. Schema v4 + segment-on-seal wiring.** `view.steps[]` field; migrate; segment on `framenavigated` per `## 5`.
- **9c. Capture-overlay UI.** Verb bar additions (`⏺ Mark start` → `🔴 Recording · N`), Recording popover, the Node→shadow binding for `setRecorderState`.
- **9d. Console UI.** `▸ Steps (N)` disclosure per `## 7`; per-step `[edit]`/`[×]`; `[Preview spec]` modal with **redaction-count chip**.
- **9e. Emitters into the Phase-7 bundle.** `recording.spec.ts` + `recording-steps.md` wired into `exportSession()` and the on-the-fly zip.

Phasing is **orientation only**; the next session re-litigates breaks/sizing before any code.

---

## Related

- `_kickoff-docs/design-qa-spikes.md` §Spike 8 (open questions enumerated)
- `_kickoff-docs/design-qa-console-architecture.md` §Phase 7 BUILT, §"Further spikes"
- `~/.claude/projects/.../memory/spike_8_interaction_recording.md` (working memory)
- `~/.claude/projects/.../memory/architecture_decisions.md` (load-bearing whys)
- POC scripts (throwaway, not shipped): `.claude/skills/design-qa/scripts/spike8-poc.mjs`, `spike8-smoke.mjs`, `spike8-redaction-smoke.mjs`
