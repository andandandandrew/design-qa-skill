# /design-qa — Help

A skill for designers to QA running web apps by placing pin annotations against a live browser. The skill exports a portable HTML artifact engineers consume.

## Commands

- `/design-qa start <session-name>` — boot a session: spawn the daemon, launch a headed Chromium, create a session directory under `./design-qa-sessions/`.
- `/design-qa end` — finalize the active session: capture any remaining view, build the HTML artifact, shut down the daemon.
- `/design-qa resume <session-name>` — *not implemented in v1.*
- `/design-qa help` — this text.

## Authoring flow

A **screen** is a logical grouping of pins for one page (or one state of a page). It captures one full-page screenshot at seal time.

1. Run `/design-qa start <name>`. A Chromium window opens at `about:blank`.
2. Navigate to the app you want to QA. Log in if needed — the skill does not manage credentials. Cookies persist via the session's browser profile.
3. To place a pin: click **+ Pin** in the panel (top-right corner). The cursor becomes a crosshair. Click anywhere on the page to drop the pin. A popover appears for the note — type, then press **↵** or click **Send**. Use **Shift+↵** for a newline; **Esc** closes the popover (notes auto-save).
4. Click any existing pin to re-open its popover (edit the note or **Delete** the pin).
5. Click **▾** in the panel header to expand the **inspector**:
    - **Screens** — rename, delete, copy URL, or jump to any screen in the session. Click anywhere on a row to focus its pin list below.
    - **+ New screen** — seals the current screen (with its screenshot) and starts a fresh one on the *same* URL. The new screen's name is selected for inline rename — give it a name so the grouping is meaningful (e.g. "Sign in — happy path" vs "Sign in — invalid email").
    - **Pins** — list of the selected screen's pins, with notes.
6. Navigate to another URL. The previous screen is automatically screenshotted and sealed before tear-down.
7. When done, run `/design-qa end`. The artifact is written to `<session-dir>/artifact.html`.

The panel (header, inspector, popover, dialogs, toasts) is invisible in every screenshot — only the numbered pins are baked into the captured image.

## What lives where

- `<cwd>/design-qa-sessions/<timestamp>-<name>/session.json` — canonical state.
- `<cwd>/design-qa-sessions/<timestamp>-<name>/artifact.html` — the deliverable (built on `end`).
- `<cwd>/design-qa-sessions/<timestamp>-<name>/screenshots/*.png` — per-view full-page screenshots.

## Troubleshooting

- **Daemon won't start.** Check `<session-dir>/daemon.log`. Common causes: Playwright not installed (run `npm install` in `.claude/skills/design-qa/scripts/`), Chromium not installed (run `npx playwright install chromium`).
- **Browser closed unexpectedly.** v1 does not auto-recover. Run `/design-qa end` to finalize what was captured, then start a new session. (Resume is phase 4.)
- **No pins on a screen but I expected some.** Pins are bound to the URL at placement time; if you navigated before placing pins, no screen was created.
