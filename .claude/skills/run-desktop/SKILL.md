---
name: run-desktop
description: Build, run, and drive the smonster Electron desktop app. Use when asked to start the desktop app, take a screenshot of it, build it, or interact with its UI (login, team/profile/proxy CRUD, etc.).
---

smonster is an Electron desktop app (main process in `electron/main/`,
preload in `electron/preload/`, vanilla JS/HTML/CSS renderer in
`electron/renderer/`) talking to a local Node/Express/SQLite backend
(`app/server/`) over HTTP + Socket.IO. For agent/automated use, drive it
via the Playwright REPL at `.claude/skills/run-desktop/driver.mjs`.

All paths below are relative to the repo root.

## Prerequisites

A reachable X11/Wayland display (`$DISPLAY`/`$WAYLAND_DISPLAY`). No
xvfb needed if one is already available in the environment — just
launch directly.

## Build

```bash
npm run build:electron   # tsc -p tsconfig.electron.json + copies electron/renderer/* (html/css/js, not compiled by tsc)
```

The backend must also be running for login/API calls to succeed:

```bash
npm start   # builds server + node dist/server/index.js, listens on :3002
```

Bootstrap a SUPER_ADMIN once (idempotent per email — errors if one already exists):

```bash
npm run create-super-admin -- <email> <password> <displayName>
```

## Run (agent path)

```bash
cd /home/thinolord/Projets/smonster
node .claude/skills/run-desktop/driver.mjs
```

Wrap in tmux for interactive use:

```bash
tmux new-session -d -s app -x 200 -y 50
tmux send-keys -t app 'cd /home/thinolord/Projets/smonster && node .claude/skills/run-desktop/driver.mjs' Enter
timeout 20 bash -c 'until tmux capture-pane -t app -p | grep -q "driver>"; do sleep 0.2; done'
tmux send-keys -t app 'launch' Enter
timeout 30 bash -c 'until tmux capture-pane -t app -p | grep -qE "launched\.|ERROR"; do sleep 0.3; done'
tmux send-keys -t app 'ss landing' Enter
tmux capture-pane -t app -p
```

Screenshots land in `/tmp/shots/` (override: `SCREENSHOT_DIR`). **Read
the screenshot file with the Read tool afterward — the pane output
only confirms the file was written, not what's in it.**

### Commands

| command | what it does |
|---|---|
| `launch` | launch the app, wait for the window |
| `ss [name]` | screenshot -> `/tmp/shots/<name>.png` |
| `click <css-sel>` | click element via DOM `.click()`, not coordinates |
| `click-text <text>` | click button/link containing exact or partial text |
| `fill <css-sel> <value>` | set an input's value + fire `input`/`change` (app has no framework, plain DOM works) |
| `type <text>` / `press <key>` | real keyboard input (for things `fill` can't reach) |
| `wait <css-sel>` | wait for element, 10s timeout |
| `eval <js-expr>` | evaluate in the renderer, print JSON result |
| `text [css-sel]` | print `innerText` |
| `windows` | list Electron windows |
| `quit` | close the app **and exit the driver process** (see Gotchas) |

## Run (human path)

```bash
npm run electron:dev   # builds + launches directly, opens a real window
```

## Gotchas

- **This sandbox sets `ELECTRON_RUN_AS_NODE=1` globally.** If left set
  when launching Electron, the binary runs the entry file as plain
  Node (`require('electron').app` is then just a path string, not the
  API) and the window never opens — you get a `Cannot read properties
  of undefined (reading 'whenReady')` crash instead. The driver's
  `launch` command already strips it from the child env; if you ever
  launch Electron manually instead, do `env -u ELECTRON_RUN_AS_NODE
  npx electron dist-electron/electron/main/index.js`.
- **`quit` exits the whole driver process**, not just the Electron
  app (the skeleton's `rl.on('line', ...)` calls `process.exit(0)`
  after `quit`). To relaunch, re-run `node
  .claude/skills/run-desktop/driver.mjs` in the same tmux pane rather
  than expecting a `launch` after `quit` to work.
- **`electron/renderer/*.html|css|js` are NOT compiled by `tsc`** —
  `npm run build:electron` also runs `scripts/copy-assets.js` to copy
  them into `dist-electron/electron/renderer/`. If you only ran `tsc`
  directly, renderer changes won't show up.
- **Session persistence across relaunches**: a successful login
  persists a refresh token at `~/.config/Electron/refresh-token.enc`
  (via `safeStorage`), so a fresh `launch` after a prior successful
  login auto-restores the session instead of showing the login
  screen. To force a clean login-screen test: `rm -f
  "$HOME/.config/Electron/refresh-token.enc"` before `launch`.
- **`page.on('response')`/`requestfailed` never fire for API calls.**
  All network traffic (REST + Socket.IO) happens in the **main**
  process (`electron/main/cloudClient.ts`), relayed to the renderer
  only via IPC — the renderer itself never does `fetch()`. Use
  `eval`/`console`/`pageerror` listeners (already wired in the driver)
  to diagnose renderer-side issues instead.
- **A `hidden`-attribute element with its own `display: ...` CSS rule
  silently ignores `hidden`.** The browser's default `[hidden] {
  display: none }` UA rule loses to an equal-or-higher-specificity
  author rule regardless of source order. `electron/renderer/styles.css`
  has `.login-view[hidden], .app-view[hidden], .no-team-state[hidden]
  { display: none; }` to fix exactly this for the three views that are
  toggled via `el.hidden = ...` in `app.js` while also having their own
  `display: flex`. If you add another top-level view toggled the same
  way, give it the same treatment or it'll look "stuck" even though
  the state changed correctly underneath.
- **Native `confirm()`/`alert()` dialogs** (used by the team-delete danger-zone action) **auto-dismiss under Playwright unless handled.** The driver's `launch` registers `page.on('dialog', d => d.accept())` so these always proceed — if you need to test a *cancelled* confirm, you'll have to temporarily change that handler.
- **GBM/NVIDIA GPU warnings on stdout** (`nv_gbm_create_device_native
  failed`) are harmless under Wayland + NVIDIA in this environment —
  Chromium falls back to software rendering. Not a launch failure.

## Troubleshooting

- **Launch timeout (30s):** run `npm run build:electron` first —
  `dist-electron/electron/main/index.js` must exist.
- **Login screen shows but submitting does nothing visible:** check
  the `[hidden]` CSS gotcha above first — it's the exact bug that bit
  this app once. Confirm with `eval ({loginHidden:
  document.getElementById('loginView').hidden, appHidden:
  document.getElementById('appView').hidden})` before assuming the
  auth call itself failed.
- **401/network errors:** backend not running — `npm start` in a
  separate terminal/background process, listens on `:3002`.
