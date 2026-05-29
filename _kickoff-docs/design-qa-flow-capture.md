# Design QA — Flow capture (concept)

**Status:** CONCEPT ONLY (2026-05-28). Captured for future reference. **No
roadmap slot, no spike, no schema impact, no decisions made.** This document
exists so we don't lose the idea while Spike 8 (interaction recording) is
fresh; everything here is downstream of Spike 8 shipping and the surrounding
work settling.

**Working term:** "flow capture" vs. "static capture." Provisional — better
name welcome later.

---

## 1. One-line summary

Extend `/design-qa` from *static, single-screenshot* feedback to *flow-driven*
feedback that spans multiple states and pages, where each state along the
recorded path can carry its own pins and comments — and where the reviewer's
journey is itself part of the artifact the engineer reviews.

## 2. Relationship to other work

This sits **on top of** several pieces that need to exist first:

- **Spike 8 — interaction recording** (`design-qa-interaction-recording.md`):
  produces the Playwright spec + segmented `view.steps[]` per screen. This
  doc assumes that work has shipped and been used enough that we know what
  it actually feels like in practice.
- **Spike 9 — post-change regression diff** (mentioned in
  `backlog_post_demo.md`): may land before this in some form. If it does,
  the "regression detection as bonus" framing below (§7) may already be a
  solved problem from a different angle.
- **Phase 8 — UI parity** (`phase_8_ui_parity.md`): not directly related,
  but worth noting that any new authoring surface introduced by flow
  capture should inherit Phase-8's resolved sidebar/overlay patterns
  rather than reinventing them.

Flow capture is **not** scheduled. It is not on `v2-enhancements`. It is not
a spike. When and if we pick this up, we begin with a research spike —
audit what the platform actually does at that point in time, revise this
concept against reality, *then* decide whether to phase any of it.

## 3. The shift

Today: a reviewer opens the skill, drives a Chromium to a specific screen,
pins comments on that screen, seals, repeats per screen. The artifact is a
collection of (screen, pins) tuples. The engineer reviewing it sees what
the reviewer saw — but not how they got there or what came before and
after.

After Spike 8: each screen also carries the slice of actions that produced
it, exported as runnable Playwright + a human step list. The "how did
they get there" gap closes for an individual screen.

**Flow capture goes one step further:** instead of treating screens as
independent annotated artifacts that happen to carry replay scripts, treat
**the journey itself** as the unit of QA. The reviewer is doing a
walkthrough; each state along that walkthrough can earn pins; the artifact
the engineer receives is a navigable multi-state thing — not N independent
screenshots that happen to share a session.

In one sentence: **today we annotate states; this concept annotates a
journey through states**.

## 4. Authoring model (conceptual)

We are deliberately not making technical decisions here. The shape we
agreed on:

- A **session** = one open-skill instance (unchanged from today).
- A session can contain **one or more flows**.
- A **flow** = an ordered sequence of states reached via recorded actions,
  with pins attachable to each state.
- A **state** in a flow = checkpoint at which the reviewer chose to take a
  screenshot. **Implicit:** every screenshot the reviewer takes during a
  flow becomes a checkpoint in that flow. (No separate "add checkpoint"
  gesture; the existing screenshot gesture is the checkpoint gesture.)

The capture entry-point likely **rebrands** from today's framing:

```
"Start new feedback capture"
   ├── Capture static (today's behavior — single screenshot + pins)
   └── Capture flow   (new — multi-state walkthrough with pins per state)
```

This is the cleanest place to introduce the fork because it doesn't
contaminate static authoring with flow-mode UI for reviewers who don't
need it.

Notes on what we **did not decide today**:

- Where flow boundaries fall *within* a session (see §8 open questions).
- Whether the existing capture overlay grows new affordances or whether
  flow mode is a distinct surface in the console.
- Whether a flow has a name/title at authoring time or is auto-named from
  its first URL.

## 5. Review model — two preview surfaces

The engineer reviewing flow-captured feedback should have access to **two
preview surfaces**, and probably should be able to opt into either or both
per review. This is a hypothesis worth validating with engineers, not a
finalized UX.

### 5a. Low-fidelity: state navigation over screenshots

Build this **first**. Lowest-risk, highest-portability, no runtime
dependencies on the engineer's machine.

- Each state in the flow is one screenshot with its pins, exactly like
  today.
- A navigation affordance (counter "3 / 7", prev/next, possibly a thumbnail
  strip) lets the reviewer move through the recorded sequence.
- Pin behavior per state is unchanged from today.
- Works from any context — emailed `.html`, opened `.zip`, browser tab —
  no app needs to be running.

This is essentially "today's static review, looped, with navigation
between captures that share a flow."

### 5b. High-fidelity: replay environment

Build later, **only after** low-fi has shipped and we've learned what
engineers actually want. Multiple shapes are possible; we are explicitly
not picking one today:

- Embedded iframe driving the engineer's local dev server via the recorded
  Playwright script
- A separate Chromium window launched by the artifact viewer that runs
  the script, with pin overlays composited into the same window
- Something else entirely

As the script advances, pins for the current state come into view; pins
for past states fall away. The reviewer can pause, step backwards/forwards,
and inspect each state in situ in a running app.

**On the iframe constraint:** the project's architecture decisions
deliberately rule out iframes for the *capture* surface (cross-origin
control issues, pin coordinate fidelity on a page we don't own). That
rule was about capture, not review. The review surface drives a local
dev server with a script *we* generated — a different threat model. So
"no iframe on the capture side" does **not** automatically mean "no
iframe on the review side." It does mean: if we revisit iframes for
review, we re-do the analysis from scratch, with the review-side
constraints, and document the outcome. We do not assume the existing
decision either way.

### 5c. Both surfaces likely coexist

Intuition: engineers will want low-fi when the dev environment isn't
running (quick triage on a phone, archived review months later, contexts
where bringing up the app is impractical) and high-fi when actively
fixing the bug at their desk. **Both as a permanent shape**, not as a
migration where one replaces the other. Test this assumption with
engineers before committing.

## 6. Adjacent functional fork worth naming

There are arguably **two distinct things** people might want when they
hear "record the QA workflow":

1. **Recording-as-artifact, no per-step pins.** Just capture the Playwright
   spec so an engineer can reproduce the state of the static screenshot.
   *This is what Spike 8 already does.* No new pinning surface, no
   multi-state review, no UX rebrand. The flow exists in the bundle as a
   `.spec.ts` file and a step list; review is still static.

2. **Recording-as-spine for multi-state pin annotation.** This document.
   The flow is not just an artifact in the bundle — it is the structural
   backbone of the feedback. Multiple states are first-class, each carries
   pins, review has navigation/replay.

These don't fight each other — (2) is a superset of (1) — but they are
clearly different products with different UX surface area. When we
revisit this, the first question is "are we building #1, #2, or both as
distinct modes?" Capturing the question here so we have to answer it,
rather than drifting toward one without realizing.

## 7. Bonus: regression detection (free signal)

In the high-fi replay environment, if the recorded Playwright script no
longer reaches the next annotated state — locator changed, route renamed,
form added a required field — that failure is itself a signal: *something
about this flow changed since QA was recorded.* That's a regression-
detection feature falling out of the architecture for free.

Caveats worth recording so we don't oversell it later:

- It's only a signal for *flows that have been QA'd*, not the app at
  large. Not a replacement for general regression testing.
- It catches structural regressions (locator no longer matches, navigation
  doesn't land on the expected URL) much better than visual regressions
  (toast moved 12 pixels) — visual regressions are Spike 9's territory.
- Spike 9 may land **before** flow capture, possibly in a different form
  that already covers the structural-regression case. If so, this section
  becomes "and flow capture inherits that signal too" rather than "new
  signal."

## 8. Open questions (preserved, not resolved)

These are the questions we explicitly **did not answer** in the
discussion that produced this doc. They are not blockers — they are
deferred. When we pick this back up, start here.

1. **Flow boundaries within a session.** A session can hold multiple
   flows; what tells us where one ends and the next begins?
   - Explicit gesture in the capture surface ("End flow / start new
     flow")?
   - Implicit by navigation reset (return to the same starting URL ⇒
     new flow)?
   - Implicit by idle gap?
   - Don't distinguish at all — one timeline, group later in the
     console?

   Author's lean: explicit gesture, for authoring clarity. Not decided.

2. **Capture entry-point UX.** Is the static-vs-flow fork a new screen
   in the console, a toggle on the existing "Add page" affordance, or
   something else? Don't decide until we have Spike-8 patterns to build
   on.

3. **Review-side iframe.** Reopened deliberately; see §5b. Not decided.

4. **One preview surface or two?** §5c is a hypothesis. Validate with
   engineers before committing.

5. **What counts as a state.** §4 says "every screenshot." Is that
   right once a flow can run for many minutes and produce dozens of
   screenshots? Maybe yes, maybe we need a denser/sparser policy.

6. **Naming.** "Flow capture" / "flow" / "journey" / "walkthrough" —
   pick when we have a real surface to label.

7. **Relationship to Spike 9.** If Spike 9 ships first and covers
   regression detection, what (if anything) does flow capture's high-fi
   replay add beyond what Spike 9 already gives an engineer?

8. **Scope of "one flow."** Is a flow constrained to one tab, one
   origin, one auth context? Spike 8 already addresses some of this for
   single-screen recording; flow capture inherits whatever it decides
   plus may add cross-flow questions.

## 9. Explicit non-decisions (so nobody pretends we decided)

For future-us, listing what was **deliberately left open**:

- We did not decide whether flow capture is one product or two (the
  §6 fork).
- We did not decide the review surface shape (low-fi only, high-fi only,
  both).
- We did not decide on iframes for the review side.
- We did not decide flow boundaries within a session.
- We did not decide what gestures the reviewer uses.
- We did not decide a name.
- We did not decide a schema. The "screenshot per checkpoint" framing
  *implies* extending the existing `views[]` shape, but that's an
  implementation question for the spike, not a decision here.
- We did not decide this is happening. It is on the backlog as a
  concept, not a commitment.

## 10. When we pick this up

Sequence — do not skip:

1. Confirm Spike 8 has actually shipped and Playwright specs are being
   produced in real sessions.
2. Confirm Spike 9 status — what does regression detection already do,
   and what gap (if any) remains for flow capture to fill?
3. Run a research spike: what is the platform actually capable of at
   that point in time (recorder maturity, console patterns, replay
   tooling), and what gaps must close to deliver §4 and §5?
4. Re-read this doc against that reality. Most of §4–§7 will probably
   need editing; that's expected.
5. Revisit the open questions in §8 with the benefit of having used the
   shipped Spike-8 product for real.
6. **Then** phase.

---

## Related

- `_kickoff-docs/design-qa-interaction-recording.md` — Spike 8 (prerequisite)
- `_kickoff-docs/design-qa-spikes.md` — spike catalog including Spike 9
- `~/.claude/projects/.../memory/spike_8_interaction_recording.md`
- `~/.claude/projects/.../memory/backlog_post_demo.md` — where this concept
  lives in the working memory until/unless promoted
- `~/.claude/projects/.../memory/architecture_decisions.md` — the
  "no iframe" decision §5b reopens for the review side only
