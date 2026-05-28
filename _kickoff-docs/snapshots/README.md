# Overlay snapshots

Frozen copies of `overlay/inject.js` at notable points so the look-and-feel
can be diffed across iterations without rolling back the working tree.
Mirror tags exist in git (use `git checkout <tag> -- …` to revert a single
file).

| Snapshot file | Git tag | What it captured |
|---|---|---|
| `overlay-9c-labels-baseline.js` | `9c-labels-baseline` (commit `b443e88`) | 9c shipped with labeled verbs (Comment / Record / New) + Save as a typography-only accent CTA. Recording chip used a pulsing red dot when active. |
