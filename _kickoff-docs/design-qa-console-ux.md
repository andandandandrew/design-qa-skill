# Design QA Console — UX & Editor Spec (Phase 1)

Resolves **Spike A** (console UI workflows & affordances) and **Spike B** (manual upload &
coordinate model), and records a **thin Spike C** decision (localhost serving) — enough to
phase the build, not to implement it.

Parent: `design-qa-console-architecture.md` (the v2 pivot). This doc is the design input
to **Phase 2** (the pin-on-image editor) and downstream phases. Nothing here is built yet.

The look/feel is the existing Figma dark theme already proven in `artifact/build.mjs`
(`--accent: #0d99ff`, three-pane layout). The console **refactors that proven render into
reusable buildless ES modules** and adds editing on top — it is not a from-scratch UI.

---

## 1. Information architecture — two screens

### 1a. Session list (console home)

Lists **all sessions in the working directory** (`design-qa-sessions/`), newest first —
historical lookback for free. Reachable even when no capture is happening (a PM reviewing
old sessions; a manual-only project with no browser).

Each session is a card:

- Session name + date
- Counts: `N screens · M pins · K unresolved`
- Source mix indicator (browser / manual / mixed)
- **Live** badge if a capture daemon is currently attached to this session

Primary actions on this screen:

- Click a card → open the **session view**.
- **+ New screen (upload)** → manual-upload flow (§4), creating/﻿targeting a session.

### 1b. Session view (the working surface)

The proven three-pane layout from `build.mjs`, now editable:

```
┌──────────────┬────────────────────────────┬──────────────────┐
│  SCREENS     │   CANVAS                   │   COMMENTS       │
│  (sidebar)   │   (pin-on-image editor)    │   (pins panel)   │
│              │                            │                  │
│  • Screen A  │   ┌──────────────────┐     │  ① note · cat    │
│  • Screen B  │   │  screenshot with │     │     ☐ resolve    │
│  • Screen C  │   │  ②  ① pins       │     │  ② note · cat    │
│  + Add screen│   │      ③           │     │     ☑ resolved   │
│              │   └──────────────────┘     │  ③ ...           │
└──────────────┴────────────────────────────┴──────────────────┘
        top bar: session name · filter/sort · Export · ● live
```

- **Left — Screens sidebar:** one card per screen (name, url-or-source, pin count,
  resolved/total). Reorderable (drag). `+ Add screen (upload)` at the bottom. Active screen
  highlighted (`--accent-dim`).
- **Center — Canvas / editor:** the frozen screenshot with `%`-positioned pin markers. The
  whole of §3. Resizable layout falls out of `%`-positioning for free (the original Phase-5
  ask).
- **Right — Comments panel:** the pins for the active screen as cards (note, category,
  author, status). Resolve checkbox + optional completion note. Sort & filter (§5).
- **Top bar:** session name, sort/filter controls, **Export** (versioned, Phase 7), and a
  live indicator when a capture daemon is attached.

The three panes stay in sync: selecting a marker highlights its comment card and vice versa
(this bidirectional select already exists in `build.mjs` and is preserved).

---

## 2. Affordance vocabulary (must read for a non-technical PM)

Plain-language labels, no jargon. The minimum toolbar set:

| Affordance        | Where            | Plain meaning                                  |
|-------------------|------------------|------------------------------------------------|
| **Add pin**       | canvas toolbar   | "Click to drop a comment on the screenshot."   |
| **Resolve** (☐/☑) | comment card     | "Mark this comment handled." (designer-side)   |
| **Add screen**    | sidebar footer   | "Upload a screenshot to comment on."           |
| **Export**        | top bar          | "Save a shareable file for engineers."         |
| **Filter / Sort** | top bar          | by status · category · author · screen         |
| **● Live**        | top bar / card   | "Someone is capturing into this right now."    |

Two interaction *states* a PM never has to name but will feel:

- **View** (default): click a pin to read/select it. No accidental pin creation.
- **Place** (armed by **Add pin**): the next canvas click creates a pin; mode then exits.

Reading-only is the resting state, so a PM clicking around never creates stray pins.

---

## 3. Pin-on-image editor (the Phase-2 deliverable)

Built **once**; serves review, post-freeze edits, and manual-screen authoring. Mirrors the
live overlay's interaction model (`overlay/inject.js`) so capture and console feel
continuous — deferred-create composer, single-line "pill" for a brand-new pin's note,
multi-line card for an existing one, Figma teardrop marker.

**Operations (all against the frozen screenshot, never live DOM):**

| Op            | Gesture                                   | Writes              |
|---------------|-------------------------------------------|---------------------|
| Place pin     | Add pin → click canvas                    | new pin at `%`      |
| Move pin      | drag marker                               | `xPct/yPct`         |
| Edit note     | click marker / card → edit text           | `note`              |
| Set category  | category control on the card              | `category`          |
| Delete pin    | trash on popover/card                     | remove pin          |
| Resolve       | checkbox on card (+ optional note)        | `status`, `resolvedNote` |
| Reorder pins  | (sort controls; explicit reorder deferred)| —                   |

**Marker states (visual):** default `#0d99ff` teardrop with index · hover · selected
(ring) · **resolved** (dimmed + check glyph). Resolved is new vs. `build.mjs`.

**Persistence seam (Phase-2 critical):** the editor never writes to disk directly. Every
op calls an injected `store` adapter — `createPin / updatePin / movePin / deletePin /
resolvePin`. In Phase 2 this is an **in-memory adapter** over a fixture `session.json`; in
Phase 4 the same interface is backed by the daemon HTTP API. Keeping this seam clean is the
whole point of building the editor standalone first.

**Phase-2 validation goal:** prove `%`-positioning holds — markers stay glued to image
features across window resize and across screenshots whose intrinsic pixel size differs
from the live viewport (full-page captures). This is the "validate %-at-rest in practice"
check the architecture doc flagged.

---

## 4. Manual upload & coordinate model (Spike B)

**Flow:** `+ Add screen (upload)` → pick an image file → name the screen → it becomes a
screen with `source: 'manual'` and the uploaded image as its `screenshot` → annotate with
the §3 editor. No browser, no daemon-Playwright involvement required.

**Coordinate model — `%`-of-screenshot at rest (unifies both paths):**

A pin stores `xPct, yPct ∈ [0,100]`, relative to the **screenshot image's intrinsic
dimensions**, top-left origin. Rendering sets `marker.style.left = xPct% ; top = yPct%`
inside the responsive `screenshot-wrapper`; the image scales, markers follow — no JS on
resize.

- **Manual:** the image *is* the only coordinate space. `xPct = clickX / imgNaturalWidth *
  100` (same for Y). Trivially direct.
- **Browser (captured):** the overlay records page-px `x/y`. Convert to `%` using the math
  `build.mjs` already does today:
  - `dpr = shotWidth / viewport.width`
  - `docHeightCss = shotHeight / dpr`
  - `xPct = x / viewport.width * 100` · `yPct = y / docHeightCss * 100`

Both converge on the same `%`-of-image representation, so `session.json` is uniform and the
editor is source-agnostic. (Phase 3 moves this conversion from export-time into the store's
write boundary; Phase 2 just consumes already-`%` fixtures, borrowing the formula above to
generate them.)

---

## 5. Sort, filter, and live reflection

**Sort / filter** (comments panel + optionally session list): by **status**
(unresolved/resolved), **category** (the fixed v1 taxonomy), **author**, and **screen**.
Default sort = creation order (preserves the index numbering on markers).

**Live reflection during capture:** the console renders from `session.json`; while a capture
daemon is attached, pins placed in the browser must appear in the console without a manual
refresh. Transport is kept behind a small client abstraction (`subscribe(onChange)`) so it
can be swapped:

- **Leaning:** SSE pushed by the daemon on each `store.persist()` → console refetches.
- **Fallback:** poll `session.json` mtime (~1s).

Decision deferred to Phase 4; Phase 1 only fixes the **abstraction boundary** so the editor
doesn't bake in a transport.

---

## 6. Thin Spike C — localhost serving (shape only)

Enough to phase Phase 4; not an implementation.

- A Node HTTP server **bound to `127.0.0.1` only** (security: never `0.0.0.0`) serves:
  static console assets (from the skill dir) · `GET /api/session` + `GET /api/sessions`
  (all in the working dir) · `GET /screenshots/...` · a mutation endpoint writing through
  `SessionStore` · `GET /api/events` (SSE) for live updates.
- Browser opened via `open` (macOS) / `xdg-open`.

**Open question to resolve in Phase 4 (flagged here so we design for it):** today the daemon
is **per-session** and owns Playwright. But the console must (a) list *all* sessions, and
(b) work when there is **no live capture at all** (PM review; manual-only project). So the
console server should likely be a **lightweight server decoupled from the capture daemon**
— launchable without Playwright, reading the sessions dir, and *coordinating* with an active
capture daemon (if any) rather than being it. Phase 4 decides: separate console server vs.
the active daemon doubling as host. The editor and `store` seam (§3) are built to not care
which.

---

## 7. What this locks for Phase 2

- Three-pane editable session view, refactored from `build.mjs`'s render.
- The editor's six operations and the **`store` persistence seam** (in-memory now).
- `%`-of-image-at-rest as the pin coordinate model, validated by the resize/full-page test.
- A `subscribe(onChange)` boundary for live updates (no transport baked in yet).

Out of scope for Phase 2 (later phases): real schema migration (3), HTTP/SSE wiring (4),
manual-upload file handling end-to-end (5), config/author stamping (6), versioned export and
freeze/Done lifecycle (7).
