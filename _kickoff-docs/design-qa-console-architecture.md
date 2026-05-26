# Design QA Skill — Console Architecture (v2)

This document consolidates a planning conversation that significantly re-centers the
`design-qa` skill. It **supersedes specific decisions** in `design-qa-skill-spec.md`
(noted inline) and adds new research workstreams to `design-qa-spikes.md`.

It is the primary input for a phased implementation plan, which will be authored
separately before any code is pushed. Nothing here has been built yet except the
live-browser capture overlay (Phases 1–2 of the original plan).

---

## What changed, in one paragraph

The original design put everything on **one surface**: an overlay + inspector injected
into the live page, with the exported HTML artifact produced at `end`. Two realizations
moved the center of gravity:

1. A "screen" is not identified by URL — it's `URL + app state + scroll/viewport`.
   Pins anchor to a **captured screenshot**, not live DOM. So re-attaching pins to a
   live page to re-edit them is fundamentally unreliable (you can't reliably reproduce a
   form-validation error state by reloading the URL).
2. Therefore editing-after-capture must happen against the **frozen screenshot**, which
   is exactly what a review surface does. And annotating an *uploaded* screenshot (for
   React Native, or as a universal fallback) needs the same screenshot-based pin editor.

The result: a **localhost console** becomes the primary authoring + review surface, and
the live-browser overlay becomes an **optional capture accelerator** for browsable web
apps. Manual screenshot upload is the **universal path** that works for any medium.

---

## The reframing (load-bearing)

> **The console is the primary authoring + review surface. The live-browser overlay is
> an optional capture accelerator for browsable web apps. Manual screenshot upload is the
> universal path that works for any environment.**

Everything — captured or uploaded — converges in the console as "an image with pins on
it." The console's pin-on-image editor is built **once** and serves review,
screenshot-side edits (resolve / move / delete / reorder), and manual-screen authoring.

**Supersedes** the original spec's "One UI surface — overlay + inspector coexist in the
browser window. No second window, no separate dashboard tab." There is now deliberately a
second surface (the console), served over localhost.

---

## Lifecycle of a screen

- **Create / edit pins: live-only, current-state-only** (browser path). You add or edit
  pins on the page as you're looking at it; pins anchor to *that* visual state.
- **A screen freezes when you leave it or click "Done."** Two distinct events that nearly
  collapse in practice:
  - **Freeze the screenshot** — must happen the instant the live view changes
    (navigation), or the visual is lost forever.
  - **Mark "Done"** — the designer's editorial "I'm finished with this one," preparing it
    for the artifact. An explicit button.
- **After freezing, no live editing.** All post-freeze operations (resolve, move pin,
  delete, reorder, and *adding* pins to a manual/uploaded screen) happen **in the console,
  against the frozen screenshot.**

This dissolves the old "navigate back to the URL to re-edit" path entirely — there is no
revisit-URL behavior to fix, because re-access is always via the console.

**Supersedes** the original "Capture model" insofar as capture is no longer the only way a
screen comes into being (manual upload also creates screens), and sealing is now tied to
explicit Done + view-change freeze rather than only navigation/`capture` transitions.

---

## The two surfaces

### 1. Capture overlay (live browser) — accelerator, optional

The existing injected overlay (closed Shadow DOM, pin layer + chrome, deferred-create
composer). Used only for **browsable web apps** to place pins quickly against the real
page. Freezes a screenshot per screen. This is the work already done in Phases 1–2 and
survives the pivot. Its job narrows to: capture screens + place initial pins, then hand
off to the console.

### 2. Console (localhost) — primary authoring + review

A **buildless vanilla** web app (structured render modules / web components, zero build
step) served by the daemon over a localhost URL, opened in the user's normal browser.

Decided as buildless because the barrier to entry must be low for *all* personas — not
just designers who boot localhost servers comfortably, but also non-technical PMs who
just need to view and check off comments. Upgradeable to a framework later if interactivity
demands it; the `session.json` format stays portable so a standalone/hosted app remains a
future option.

The console:

- Renders **live** from `session.json` + screenshots (the daemon owns and serves them).
  Updates as screens freeze and as edits happen — no artifact recompile needed during the
  session.
- Is the home of the **pin-on-image editor** (place/move/delete pins on a frozen
  screenshot), **resolve / check-off**, reorder, and **manual screenshot upload → new
  screen**.
- Lists **all sessions in the working directory**, not just the active one → historical
  lookback for free.

**Serving mechanism:** the daemon (already a Node process owning `session.json` and a Unix
socket) runs a small localhost HTTP server: static console assets + a session/data
endpoint + screenshot files, with SSE or polling for live updates. (See new Spike C.)

---

## Capture modes

Config carries both a free-form `stack` (for the record + future code-side handoff) and a
functional `captureMode`:

- `browser` — drive a headed Chromium, place pins on the live page (web apps).
- `manual` — bypass the browser entirely; create screens by **uploading a screenshot** and
  annotating it in the console.

`manual` is **always available as a fallback** regardless of stack — for React Native,
non-browsable environments, or when the browser path is unavailable (e.g., out of tokens).
React Native defaults to `manual`; web defaults to `browser` with manual on standby.

---

## Data model

`session.json` remains the **source of truth**. Console renders live from it; edits mutate
it directly; the artifact is a frozen export of it.

**Pin coordinates: percentage-of-screenshot at rest.** Captured screens currently store
page-pixel `x/y` and convert to `%` only at export; manual uploads have no page, only an
image. Normalizing **everything** to `%`-of-screenshot unifies the two paths and makes the
resizable-sidebar rescale concern fall out for free. (To be validated in practice; chosen
as the default.)

**Pin gains fields:**

- `author` — stamped at creation from config identity. Forward-compatible with a
  git-shared, multi-author future without building any of it now.
- `category` — already reserved in the schema (fixed taxonomy from v1 spec).

**Screen gains:** `source: 'browser' | 'manual'`, and for manual screens the uploaded image
becomes its screenshot.

---

## Configuration & initialization

The expected usage: **one working directory per client/project**, kept local and
historical on the user's machine. Whether they version-control it with git is their choice
(the config is plain JSON, no secrets; committing author name is the user's call).

**First run in a new directory triggers an agent-driven init** — prompts in the terminal
(simple, no UI dependency; works for every persona since everyone is already in Claude
Code). The console can later expose a settings editor for changing these.

A local config file (e.g. `design-qa.config.json` at the directory root) holds:

- **Project / client name**
- **Stack** (free-form: "React web", "React Native", …) + derived **`captureMode`**
- **Author identity** (name; email optional) — flows into every comment's `author` field

Sessions accumulate under the working directory (as today, `design-qa-sessions/`), and the
console reads all of them for historical lookback. Distinguish clearly:

- **Where the app code lives:** inside the skill (served by the daemon). No clone/install.
- **Where session data accumulates:** the working directory the user chose.

**Supersedes** nothing in the v1 spec directly, but adds the init/config workflow the v1
spec did not contemplate.

---

## Export

- **Live view = the console**, rendered from `session.json`. No proactive recompile of
  `artifact.html` during the session.
- **`artifact.html` = an explicit, versioned export** — a frozen, self-contained,
  portable snapshot (e.g. `artifact-20260526-v1.html`) handed to engineers. The user can
  keep iterating and re-export later.

**Supersedes** the v1 behavior of building the artifact automatically at `end`. Export is
now a deliberate, versioned action triggered from the console (and/or terminal).

**Two layers of "resolve":**

- **Designer-side** resolve/check-off in the console → persists to `session.json`.
- **Engineer-side** resolve in the distributed artifact → persists separately (the
  unresolved Spike 7 question: sidecar JSON vs. LocalStorage + re-export). Still open.

---

## What stands from the v1 spec

- Percentage-based pin positioning (now generalized to all screens, see Data model).
- Designer judgment over inference — the skill does not auto-detect state changes or group
  screens; the designer demarcates ("+ New screen", Done, manual upload).
- The screenshot is the canonical artifact; selectors/DOM hints are placement convenience.
- Disposable but resumable — sessions ship an artifact; the skill is not a database. (The
  console adds *historical lookback* over the local sessions directory, which softens this
  slightly but does not make the skill a server.)
- Minimal terminal command surface — lifecycle + init in the terminal; authoring/review in
  the surfaces.

---

## Open research workstreams (new / evolved spikes)

These extend `design-qa-spikes.md`. To be probed during planning.

### Spike A — Console UI workflows & affordances *(the big new one)*

Now that the console is a primary **authoring** surface, not just review, what UI does it
actually need? To enumerate during planning:

- Pin-on-image editor: place, move, delete, edit note, set category — on a frozen image.
- Navigation between sessions and between screens within a session.
- Manual screenshot upload → new screen → name it → annotate.
- Resolve / check-off + optional completion note; visual state on both the sidebar card and
  the on-image marker.
- Reorder screens / pins; sort & filter (by status, category, author, screen).
- Resizable layout (the original Phase-5 ask) — trivial under %-positioning.
- The toolbar / affordance vocabulary that makes this legible to a non-technical PM.
- How the console reflects the *live* session while the designer is still capturing in the
  browser (real-time additions appearing).

**Done when:** we have a sketch of the console's screens, primary affordances, and the
minimum toolbar set, enough to phase the build.

### Spike B — Manual upload & coordinate model

How uploads create screens; how pins are placed as `%`-of-image; how this reconciles with
browser-captured screens so both are uniform in `session.json`. Validate the
"%-at-rest" decision.

### Spike C — Localhost serving mechanics

How the daemon serves the buildless console + data + screenshots; live-update transport
(SSE vs. polling); port selection; opening the user's browser; lifecycle (per-session,
disposable). Security: bind to localhost only.

### Spike 7 (evolved) — Engineer-side completion persistence

Unchanged in substance: sidecar JSON vs. LocalStorage + re-export for the distributed
artifact. Now clearly *separate* from designer-side resolve (which persists to
`session.json` via the console).

---

## Disposition of current code under this pivot

- **Bugs #1 (canvas pin loss) and #3 (composer pill):** already fixed; capture-overlay
  fixes that survive untouched.
- **Bug #2 (revisit sealed URL):** *not* fixed and *not* to be fixed — the console replaces
  the need; the revisit-URL path is being removed from the model.
- **Auto-seal-on-navigation, auto-build-at-end:** to be reworked into freeze-on-view-change
  + explicit Done + explicit versioned export.
