# Design QA Skill — Specification

A Claude Code skill that gives designers an authoring environment for visual QA feedback on running web apps, exporting a self-contained HTML artifact that engineers consume to drive their fixes.

This spec was developed conversationally and is the primary input for Claude Code's planning of the build. The companion spike doc (`design-qa-spikes.md`) lists unknowns that should be resolved before or alongside committing to implementation details.

A previous proof-of-concept exists (a one-off HTML file that base64-encodes a static screenshot and lets the designer place pin annotations on top of it). That POC validated the inventory-tracking value of the artifact format. This skill is a rewrite, not a refinement — the POC is reference material, not a foundation.

---

## Purpose

Designers QA running web apps by navigating to pages, examining what's there against Figma intent and design-system consistency, and capturing feedback that engineers can act on. The current workflow produces static screenshots with overlaid pins. This skill keeps the deliverable shape (annotated screenshots in an HTML artifact) but moves the *authoring* into a live browser environment so:

- Pins are placed against the real DOM, not a screenshot, improving placement fidelity
- A designer can capture multiple views and pages in one continuous session without leaving the browser
- The skill can take screenshots on the designer's behalf so capture is no longer a manual chore
- A future voice/LLM path can place pins from spoken stream-of-consciousness feedback

The artifact remains a static, portable HTML file (or small directory) that doesn't depend on Playwright or any runtime — engineers open it like any HTML file.

---

## Out of scope for v1

These were discussed and explicitly deferred:

- Responsive / multi-viewport capture flows (capture records the viewport size as metadata; no special UI for switching breakpoints)
- Persistent cross-session history or a "QA repository" app
- Jira / Figma / Storybook integration beyond optional URL fields on a session
- Threaded replies on annotations (a pin has a single annotation note; engineer-side completion is the only other state)
- LLM-driven pin placement (phase 2; the spec should not preclude it)
- Summary page in the artifact (deferred until we learn what's useful after using the skill)
- Refresh/re-screenshot of an old view to show diffs against current app state

---

## Prerequisites the designer handles

The skill expects the designer to:

- Be in a working directory of their choosing (the skill creates a session subdirectory there)
- Have the app under QA running and accessible at a URL they know
- Handle authentication themselves — log in via the headed browser the skill provides; the skill does not manage credentials or `storageState`

If the page is unreachable or auth fails, that's a designer problem to resolve outside the skill. The skill should fail visibly and helpfully but not try to recover.

---

## Skill invocation and command surface

The skill is rooted at `/design-qa` and lives in `.claude/skills/design/design-qa/`.

A session is a running, stateful thing. The skill stays alive across commands within a session. Designers interact with the skill through commands in the Claude Code terminal and with the QA target through a headed Chromium window the skill controls.

**Lifecycle commands (terminal):**

- `/design-qa start <session-name>` — initialize a session. Creates a timestamped session directory, boots headed Chromium, opens it to `about:blank` or a passed-in starting URL.
- `/design-qa capture <view-name>` — designate the page currently loaded in the browser as a new logical view. Inject the annotation overlay + session inspector into it. Designer drives the rest from the browser. Optional `--url-tag <tag>` to group views that share a URL but differ in state (per the auth-page error-state example).
- `/design-qa end` — finalize the session, ensure any pending screenshots are captured, export the HTML artifact to the session directory.
- `/design-qa resume <session-name>` — re-open a previously started session that didn't end cleanly. Restores state, reopens the browser, re-injects UI.

**Phase 2, reserved (not in v1):**

- `/design-qa annotate <natural language>` — LLM-assisted pin placement from spoken or typed stream-of-consciousness feedback. Reads current DOM, drops pins live, designer adjusts.

**No commands needed for per-pin operations.** Adding, editing, moving, deleting pins all happens in the browser overlay. Renaming or deleting whole views happens in the session inspector panel that lives alongside the page in the browser. The terminal is for session lifecycle and capture orchestration.

---

## Session shape

A session is the unit of work for one QA pass. It contains one or more **views**. A view is whatever the designer demarcates with `capture <view-name>` — typically one page or one state of a page. Views contain **pins**.

The designer's judgment is what groups feedback, not the skill's inference. The skill does not try to detect state changes, group views by URL automatically, or otherwise impose structure. URL is captured as metadata on each view and the optional `--url-tag` lets the designer link related views (e.g., signup page + signup page with errors), but how those tags get used is left to the consumer of the exported artifact.

**Pin model.**

A pin has:

- A position on the page (document coordinates — exact selector durability is explicitly not a goal; see Spike 3)
- An annotation note (free text written by the designer)
- A category (one of a fixed taxonomy — see below)
- A unique id
- Created timestamp

Categories are a fixed taxonomy for v1:

- spacing
- color
- text
- interaction
- code-pattern
- component
- workflow
- page

A pin has exactly one category. (Multi-category was not requested and would complicate the future summary page.)

**Capture model.**

Screenshot capture is **implicit, not a separate command**. When the designer moves to a new view (via `capture <new-view-name>`) or ends the session, any prior view with un-captured pins gets screenshotted automatically before the transition. The screenshot bakes in the pin overlay; the session inspector is excluded from the capture region.

Each screenshot records the viewport size as metadata. There is no special UI for switching viewport breakpoints in v1 — the designer can resize the browser before capturing a view if they want a smaller-viewport screenshot. Metadata simply records what was captured.

---

## In-browser UI: overlay + inspector (one surface)

Per the design conversation, the authoring experience is optimized for the designer's flow and lives in one screen: the live page being QA'd, with the annotation overlay drawn on top, and a session inspector panel coexisting alongside it.

**The overlay** is the layer of pins drawn on top of the page itself. Pins are placed via click. Each pin has a popover for entering/editing its annotation note and selecting its category. Pins can be dragged to adjust position. A trash control on the popover deletes the pin.

**The session inspector** is a collapsible panel that lives in the same browser window as the page. It shows:

- All views in the current session (with their names, URL, urlTag if any, pin count, viewport size)
- All pins for the currently-active view (with annotation text and category)
- Controls for renaming a view, deleting a view, or jumping the browser to a view's URL

Inspector view-level operations (rename, delete) happen here because the designer might want to clean up a view while standing on a totally different page. Page-level pin operations happen in the overlay because they are physically tied to the page geometry.

The implementation details of how to inject both into arbitrary pages without breaking them are open — see Spike 2.

---

## File layout

A session directory looks roughly like this (subject to refinement after Spike 7):

```
<working-directory>/
  design-qa-sessions/
    <timestamp>-<session-name>/
      session.json          # canonical session state — views, pins, metadata
      screenshots/
        <view-id>.png       # one per view, with pins baked in
      artifact.html         # produced on `end`; the deliverable
      state.json            # optional sidecar for engineer-side completion state
```

`session.json` is the source of truth during the session. The artifact is produced from it on `end`. Resume reads it.

The choice of single HTML file vs. directory for the artifact is open and depends on Spike 7. The designer is open to either; the deciding factor is which gives a cleaner engineer-side completion-tracking experience.

---

## Exported artifact

The exported HTML artifact is the deliverable. It is:

- Self-contained (no Playwright dependency, no Node, no build step to view)
- Portable (a designer should be able to share it via Slack, Drive, email, or commit to a repo)
- Frozen at time of export — pins, annotations, screenshots, categories, view structure are baked in
- Mutable only for engineer-side completion state (see below)

**What the engineer can do with the artifact:**

- View all sessions/views/pins in an organized way
- Mark a pin as complete (Figma-comment-style)
- Optionally write a completion message when marking complete (not a fixed set of statuses — free text, indicating that a human acted on the pin in some way)
- Sort/filter by completion status, page/URL, and category

Completion state must persist for the engineer. Single HTML file + LocalStorage doesn't survive re-share. The two viable models:

1. The engineer exports an updated HTML artifact with completion state re-baked into the markup
2. The artifact lives in a small directory and reads/writes a sidecar JSON for state

Recommendation deferred to Spike 7.

**The summary page is deferred.** v1's artifact opens to the session view list (or to the first view directly — TBD). After we use the skill on real projects, we will know what summary metrics are worth surfacing.

---

## Resume capability

Resume is in scope for v1.

If the Chromium window is closed mid-session (intentionally or accidentally), the skill prompts: *the browser closed — do you want to reopen and continue, or end the session here?* Closing the laptop and coming back the next day is handled by `/design-qa resume <session-name>`, which restores from `session.json` and re-opens the browser.

Resume edge cases (auth expired, URL changed, page no longer loads) are addressed in Spike 6.

---

## Voice / LLM placement (phase 2)

Out of scope for v1 implementation, but the spec reserves space for it. The phase-1 architecture should not preclude phase 2.

Specifically: when phase 2 ships, the LLM places pins by reading the live DOM (likely the accessibility tree — see Spike 5) and dropping pins with annotation text and category pre-filled. The designer reviews and adjusts in place. There is no draft state — an LLM-placed pin is just a pin from the moment it appears.

---

## Open dependencies on spikes

| Decision | Depends on Spike |
|---|---|
| Authoring driver (Playwright vs. alternatives) | 1 |
| Overlay + inspector injection approach | 2 |
| Pin anchoring approach | 3 |
| Screenshot composition mechanics | 4 |
| Phase-2 LLM placement shape | 5 |
| Resume restoration sequence | 6 |
| Export format and completion-state mechanism | 7 |

Each spike's outcome may refine this spec.

---

## Design intent worth preserving

A few principles surfaced during the planning conversation that should guide implementation choices when the spec is silent:

- **Author-optimized UX.** This is a tool a designer uses live while doing real QA. Friction in the authoring loop is the most expensive friction in the whole system.
- **Designer judgment over inference.** The skill does not try to guess what counts as a new view, which pins relate to each other, or how feedback should be grouped. The designer demarcates; the skill records.
- **The screenshot is the canonical artifact.** Selectors and DOM hints are convenience for placement, not durable identifiers. Don't over-engineer them.
- **Minimal command surface.** Terminal commands cover session lifecycle. Everything else happens in the browser. Adding a command is a cost.
- **One UI surface.** Overlay + inspector coexist in the browser window. No second window, no separate dashboard tab.
- **Disposable but resumable.** Sessions live as long as they need to and then ship an artifact. The skill itself is not a database or a long-running app.
