# Design QA Skill — Research Spikes

This document captures the technical unknowns that should be probed before the `design-qa` skill spec is finalized. Each spike has a question to answer, a rough approach, and what "done" looks like.

These spikes are a precondition to committing to the skill spec. Findings will sharpen — and may reshape — the spec's command surface, file layout, and UI model.

---

## Spike 1 — Playwright as the authoring driver

**Question.** Is Playwright (used as a Node library, headed Chromium) the right tool for driving the designer's QA browser session? Or is a browser extension, Chrome DevTools Protocol directly, or Puppeteer a better fit for this use case?

**Why it matters.** The whole authoring environment hangs off this choice. We need a browser the designer can drive naturally (navigate, log in, click around) that also lets us inject UI, listen for clicks, capture screenshots, and persist state across navigations.

**What to probe.**

- Can we launch headed Chromium from a Node process, hand control of navigation to the designer, and still inject scripts/styles into every page?
- Can injected UI (overlay + inspector panel) persist cleanly across SPA route changes, hard navigations, and authenticated redirects?
- What happens to injected state when the page does a full reload vs. a client-side route push?
- Are there cleaner alternatives (extension, CDP direct) that we'd regret not evaluating?

**Done when.** We have a one-paragraph recommendation with confidence level. If Playwright is the answer, we know how to handle injection across SPA navigations. If it isn't, we know what is and why.

---

## Spike 2 — Overlay + inspector injection model

**Question.** How do we inject the annotation overlay and the session inspector panel into arbitrary pages without breaking the page being QA'd?

**Why it matters.** The designer is QA'ing real apps. Our injected UI cannot interfere with the app's own layout, styles, event handlers, or routing. We also need the inspector to coexist on-screen with the page (not in a separate tab/window) per the agreed UI model.

**What to probe.**

- Shadow DOM for isolation — is the ergonomic overhead worth the isolation guarantee?
- Z-index, pointer-events, and event-bubbling pitfalls when overlaying on top of arbitrary apps
- How the inspector panel should claim screen space — a fixed sidebar that resizes the page (intrusive but visible) or a floating/collapsible panel (less intrusive but easier to lose track of)
- Whether the inspector needs its own document or can live in the same page DOM as the overlay
- How injected scripts re-attach on SPA navigation (mutation observers? Playwright's `addInitScript`?)

**Done when.** We have a working injection prototype that survives navigating between three different sites with different stacks (e.g., a React SPA, a Next.js app, a server-rendered site) and an opinion on shadow DOM vs. plain DOM isolation.

---

## Spike 3 — Pin-to-element capture (lightweight)

**Question.** What's the minimum-viable way to capture which element a pin was placed on, given that we explicitly do not need hyper-specific or durable selectors?

**Why it matters.** Designer confirmed selectors are only for approximate placement, not for engineer-side element identification. We need *something* to anchor a pin to its rough location so that the pin survives minor scroll or re-render between placement and screenshot capture. But we should not invest in resilient-selector logic.

**What to probe.**

- Is capturing `(x, y)` in document coordinates enough, given that the screenshot is the canonical artifact?
- If we do capture a selector, is `document.elementFromPoint(x, y)` plus a shallow descriptor (tag + classes + nearest test id, if any) sufficient?
- Do we need to re-find the element before screenshot to re-anchor the pin position, or is "pin stays where it was dropped in viewport coords" fine?

**Done when.** We have a decision: pure coordinate anchoring vs. coordinate + lightweight selector hint, with rationale. The bar is "good enough for v1, not engineered for durability."

---

## Spike 4 — Screenshot capture mechanics

**Question.** When the designer is done annotating a view, how do we capture a screenshot that includes the pins overlaid on the page?

**Why it matters.** The screenshot is the canonical handoff artifact. Pins must appear baked into the image. The page being QA'd may be longer than the viewport (full-page screenshot) or modal-bound (constrained capture).

**What to probe.**

- Playwright's full-page screenshot vs. viewport screenshot — which is the default for a "view"?
- Does the pin overlay render correctly in screenshots taken via Playwright's screenshot API, or do we need to compose the image (page screenshot + pin layer drawn programmatically)?
- How do we exclude the inspector panel from the screenshot? (Either hide it pre-capture or use a clipping region.)
- What happens with lazy-loaded content below the fold during full-page capture?

**Done when.** We have a working capture path that produces a PNG with all pins for the current view visible and the inspector excluded.

---

## Spike 5 — Voice / LLM annotation placement (phase 2, but scoped now)

**Question.** When the designer speaks a stream-of-consciousness description, how does the LLM convert it into discrete pins placed against the live DOM?

**Why it matters.** This was the POC's strongest UX win and is the most differentiated piece of this skill. Phase 1 ships without it, but the spec should know what it's reserving space for.

**What to probe.**

- What's the right DOM serialization to hand the LLM? Full DOM is too big; accessibility tree is probably the right level (it gives labels, roles, and structure without noise).
- How does the LLM communicate "place a pin at the email input" back to us? A list of `{description, target}` pairs where `target` is something we can resolve to coordinates?
- What's the fallback when the LLM can't resolve a target confidently? Drop the pin at a default location (center of viewport?) with a flag for designer attention?
- Latency — is this an interactive turn or does the designer say their piece, hit submit, and wait?

**Done when.** We have a design sketch for the phase-2 path with one paragraph on each open question. Not a working implementation — just enough to know the spec accommodates it.

---

## Spike 6 — Session resume

**Question.** How does the skill resume a session after the designer closes the laptop and comes back?

**Why it matters.** Designer confirmed resume is in v1. State lives in a session directory. We need to restart the Chromium browser, re-inject overlay + inspector, restore pins and views, and put the designer somewhere reasonable.

**What to probe.**

- What's the canonical session state file format? (JSON, with views, pins, metadata, screenshot file references.)
- On resume, do we re-open the browser to the last view's URL, or land on a session inspector "start screen" and let the designer navigate?
- How do we handle the case where the URL no longer loads (app changed, auth expired) on resume?

**Done when.** We have a resume flow sketched: file format, restoration sequence, edge cases.

---

## Spike 7 — Export format and sidecar state

**Question.** What does the exported HTML artifact look like, and how does engineer-side completion state work?

**Why it matters.** This is the handoff. It needs to be portable (single file or small directory), self-contained (base64'd images, embedded styles), and friendly to a future engineer-side completion-tracking layer.

**What to probe.**

- Single HTML file (base64 images inline) vs. small directory (HTML + `screenshots/` + `state.json`). Designer is open to either; we should pick based on what gives a better engineer experience for completion tracking.
- If sidecar JSON for completion state: how does the engineer-side HTML know to read/write it? (File system access API? Manual export of an updated artifact?)
- Should the exported HTML embed the source data (so it can re-render with state changes) or be a snapshot (frozen markup that gets selectively modified)?

**Done when.** We have a recommended export shape, with the completion-state mechanism specified concretely enough to build.

---

## Out of scope for spikes

The following are deferred per the planning conversation and should not be probed in this round:

- Responsive / multi-viewport capture flows
- Persistent multi-session history (a QA repository)
- Jira / Figma / Storybook integration depth
- Threaded replies on annotations
- Summary page contents in the artifact
- Commit gates between pin drop and pin persistence
