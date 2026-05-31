# Design QA — Feedback platform (reframe + spec)

**Status:** ACTIVE REFRAME (2026-05-31). The mental model is decided. The two new capture
methods (Spikes 11 & 12 in `design-qa-spikes.md`) are now **POC-validated FEASIBLE — high
confidence** (2026-05-31); both reuse the exact seams pins ride on. Remaining gating is the
parallel UX design in Claude Design, then phased implementation. The browser-fixture UI
update is specced here but is explicitly the **last** thing built. See the spike catalog's
"POC RESULT" blocks for measured numbers + recommended data shapes.

---

## 1. The reframe — one line

`/design-qa` is a **feedback platform, not a commenting platform**. A reviewer doesn't
"leave a comment" — they **add feedback**. A pinned text note is just *one kind* of
feedback. Today's product is the special case where the only kind is "text pin."

## 2. The three kinds of feedback

All three are first-class, share the same review/handoff pipeline, and are unified by a
`type` discriminator on the feedback record:

1. **Pinned text** (`type: 'text'`) — today's behavior. Drop a pin at a point, write a note.
2. **Drawing / markup** (`type: 'drawing'`) — freehand draw on the page to direct attention
   (visual signal), with an **optional** text note. A bare circle with no words is valid
   feedback. → **Spike 11.**
3. **DOM-element selection** (`type: 'element'`) — select a live element; the system
   captures its outline rectangle + a human element name; attach a note. → **Spike 12.**

The reviewer's gesture differs; the *thing produced* is one unified feedback record that
flows through the same persistence, screenshot review, sidebar list, and export.

## 3. Why a `type` discriminator (and not `category`)

There is already a **category** mechanism (Visual / Copy / Spec / Question / Bug — see
`console/core.mjs` `CATEGORY_META`). Category is an **orthogonal triage tag**: it drives
filtering and a color dot, nothing structural. It is the **wrong** place to encode the
*kind* of feedback — overloading it would force a non-optional, combinatorial tag set and
break triage grouping.

Instead: add a `type` field to the feedback record (default `'text'` for back-compat),
carrying a type-specific payload alongside the shared fields. Category stays as-is, fully
orthogonal — a `drawing` can be tagged `Bug`, an `element` can be tagged `Visual`, etc.

```
feedback record (today's "pin"):
  { id, viewId, type, xPct, yPct, note, category, author, status, resolvedNote, createdAt }
                  ^^^^ new, default 'text'
  type:'drawing' adds:  shape:   { kind, points[]|bounds, strokeWidth, color }
  type:'element' adds:  element: { bounds:{xPct,yPct,wPct,hPct}, name, descriptor? }
```

This is **direction, not a committed schema** — the spikes finalize the payload shapes.

## 4. The load-bearing invariant every kind must honor

**Feedback is NOT baked into the screenshot PNG.** Pins render as an overlay from
`session.json` at review time (`console/ui/canvas.mjs` `buildMarker`, `%`-positioned; the
overlay chrome is hidden during capture via the `capture-mode` class). Drawings and element
outlines **must follow the same rule** — store the shape/box at-rest, render it as an
overlay (SVG / positioned box) over the screenshot in the shared canvas module. Never
rasterize feedback into the PNG. This is what keeps everything responsive (`%`-at-rest) and
editable/resolvable after capture.

Corollary: all kinds normalize to **%-at-rest** via the existing px→% seal path
(`lib/coords.mjs` `pagePxToPct`), exactly as pins do today.

## 5. Review-surface implications

- **Canvas overlay** (`console/ui/canvas.mjs`): the per-pin marker loop branches on `type` —
  a numbered bubble for `text`, an SVG path for `drawing`, an outline rectangle (+ name
  label) for `element`. All `%`-positioned over the responsive screenshot wrapper.
- **Sidebar list** (`console/ui/comments.mjs` `buildCard`): heterogeneous cards. A drawing's
  card shows a shape thumbnail/summary; an element's card shows the captured element name;
  a text card is unchanged. The existing ⋯ menu, category tag, and resolve check apply to
  all kinds uniformly.
- **Shared renderer**: because the console and the exported artifact both run the same
  `canvas.mjs` / `comments.mjs` over a swappable store adapter, type-aware rendering
  propagates into the artifact automatically — no separate artifact scaffolding.

**Open question (not decided):** Do we *visually differentiate* the kinds in review (icons,
card shapes), or treat everything as "a piece of feedback" with minimal distinction? The
"it's all just feedback" philosophy argues for low differentiation; usability may argue for
some. Decide once we can see real heterogeneous artifacts.

## 6. Browser-fixture UI update (the LAST build step)

Specced now so the spikes can design toward it; built last, after the capture methods land
and are tested one at a time.

- **Toolbar realign → vertical.** Today the mini-toolbar is a horizontal top-center pill
  (`inject.js` `.toolbar`, `position: fixed; top:16px; left:50%`). Realign to a **vertical**
  orientation with a **new default position** (anchor TBD in design — likely an edge dock).
  The draggable behavior + Node-side position persistence (`toolbarPos`, the
  `setPointerCapture` grip drag, `__designQA_setUiState`) carry over unchanged in mechanism;
  only the default anchor + axis change.
- **New actions.** The toolbar gains the new feedback-mode entry points: a **draw** action
  (Spike 11) and an **element-select** action (Spike 12), alongside the existing comment /
  new-screen / record / done. Treat them as placeholder slots until the spikes finalize the
  gestures.
- **Recording banner reposition → toward top.** The recording indicator
  (`inject.js` `.rec-ind-*`: pill + step count + steps timeline) moves toward the top of the
  page. **Its expand/collapse mechanics and the controls inside it stay the same** — only
  position changes.

## 7. Phasing

1. **Spikes 11 & 12** validate feasibility + performance (in tandem with the user's Claude
   Design work). No code commitment until they report.
2. **Implement one capture method at a time** — each landed and tested in isolation before
   the next, so we can confirm each works the way we need. Order TBD (likely whichever the
   design settles first).
3. **Browser-fixture UI update + recording-banner reposition LAST** — once the new modes
   exist and need permanent homes in the toolbar.

Implementation must respect the existing seams (swappable store adapter, shared render
modules, the binding layer, the `type` discriminator) — this keeps both the features and the
eventual standalone-app cutover (`design-qa-standalone-app.md`) clean.

## 8. Decisions resolved by the POCs (2026-05-31)

- **`drawing` render** = SVG (`viewBox 0..100` + `non-scaling-stroke`), not canvas.
- **`drawing` shape model** = freehand path first (RDP-simplified on seal); primitives later.
- **`element` selector** = keep NONE (box + `name` + optional shallow `descriptor`); Spike 3.
- **`drawing` ↔ `element` render** = stay distinct `type`s but share a `buildBoundsBox(pct)`
  primitive (an element box and a rect-drawing are the same %-positioned rectangle).
- **Pick-under-overlay** = toggle the veil `pointer-events:none` for the hit-test, restore.

## 9. Explicit non-decisions (still open)

- Final field-level schema sign-off (the POC shapes are the strong recommendation).
- Whether review **visually differentiates** feedback kinds (§5) — UX call.
- The toolbar's exact new default anchor + the new actions' icons/gestures (design decides).
- Save/exit gesture for drawing (explicit Save vs. tool-toggle-off).
- Whether a bare `element` selection with no note is kept (POC lean: allow, deferred-create).

## Related

- `_kickoff-docs/design-qa-spikes.md` — Spikes 11 (drawing) & 12 (element inspector).
- `_kickoff-docs/design-qa-standalone-app.md` — the architecture cutover sequenced after
  this feature expansion.
- `inject.js` — the overlay (toolbar, recording banner, composer, placement mode).
- `console/ui/canvas.mjs`, `console/ui/comments.mjs`, `console/core.mjs` — the shared
  render pipeline + category model the `type` discriminator extends.
