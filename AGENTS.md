# Repository Guidelines

## Project Overview

Dashboard + automation for **bulk registration of Dropbox accounts** (account farming via referral links). A Node.js server exposes a web dashboard and drives a **camofox-browser** REST server (anti-detect Camoufox) that is vendored inside this project; exit IPs rotate through **warp-go** (rootless Cloudflare WARP, SOCKS5), **Psiphon**, or a user-supplied SOCKS5. After the signup form is filled, the vendored **Dropbox daemon** links the new device and triggers the verification email.

Two run modes, same engine:
- **Dashboard**: `node server.js` → `http://localhost:3000` (batch orchestration, live console, progress ring, settings, selector editor, engine status/rotation controls).
- **Interactive CLI**: `node register.js` (prompts for referral URL + `;`-separated emails; `--proxy=true`, `--init=true` flags).

All UI text, log messages, and comments are **Bahasa Indonesia**; identifiers are English-ish camelCase. Branch: `webui3` (remote `https://github.com/Dewamade/Dropbox`).

**x86_64 Linux only.** The vendored Dropbox and Psiphon binaries are x86_64-only; `setup.sh` exits early on any other platform. No Playwright, no system browser, no `warp-ctl`, no Docker, no box64: every executed binary lives in this project directory.

## Architecture & Data Flow

Four-layer backend; the whole frontend is one file.

```
public/index.html (vanilla JS, 1 file: REST + WebSocket client, tabs: Progress / Pengaturan / Selector)
        │  REST /api/*                        │ WS JSON  {action:'start'|'stop'|'ping'}
        ▼                                     ▼
server.js ── Express 5 + ws: batch loop over emails, phase (exit-IP) rotation, worker
        │      state machine, console.* hijack → WS broadcast, live preview screenshots
        ▼
register.js ─ registerSingleEmail(): one camofox *session* per email (userId-keyed
        │      profile), selector-driven form fill, dropboxd spawn + cli_link linking
        ├── camofox-manager.js  spawns/limits ./camofox-browser/server.js (exit path is
        │                       fixed at process start → spec change restarts it)
        ├── camofox-client.js   REST client for one session (tabs, evaluate, click/type)
        └── proxy-manager.js    warp-go + psiphon-tunnel-core lifecycle, SOCKS exit-IP
                                preflight, rotation (new WARP key / new Psiphon region)
db.js ── JSON-file persistence (history.json: registrations + settings + selectors)
```

Data flow per run: UI sends `action:'start'` with the full config → `server.js` builds the email list (`emailMode:'auto'` generates `first.last<2digits>@<domain>` from syllable names, else splits `emails` on `;`) → for each email it builds an ordered phase list from enabled toggles (`direct` → `warp` → `psiphon` → `socks5`; at least one phase is always forced) → inside a phase, `runBrowserLoop` retries up to `globalRetry` times → first success ends the email; total failure for an email **stops the whole batch** and goes idle → every result is written by `saveRegistration()` and mirrored to the UI via WS events.

Per-email exit path (`register.js: ensureExitPath`) → `proxy-manager.startWarp/startPsiphon` (with `rotate` on retry) → `camofox-manager.ensureRunning({proxy, visible})` restarts the browser server if the requested exit/visibility differs → in-browser preflight opens `api.ipify.org` and logs the real exit IP + UA before any account is spent.

Cross-module coupling is via Node `global` (not parameters): `global.safeSend`, `global.killAllVpnProxy`, `global.closeBrowserSession`, `global.killDropboxDaemon`, `global.isDropboxRunning`, `global.previewScreenshot`, `global.livePreview`, `global.currentUserId`, `global.camofoxTab`, `global.warpRotateNext`, `global.psiphonRegions` / `psiphonUsedRegions`, `global.debugProxy`, `global.activeWs`. Preserve this bridge when refactoring.

Worker state machine (`server.js`): `BOOT` → `PROCESSING` → `FINISH` → `IDLE`, driven by a configurable idle timer (`idleTimeout`, default 600 s) that emits `idle_warning` 60 s early; `POST /api/worker-stat/extend|idle` reset or force it, and only from `BOOT`/`FINISH`.

Server→client WS `type`s: `status`, `sync_state`, `worker_status`, `progress`, `log`, `email_success`, `email_stats`, `preview`, `idle_warning`, `idle_warning_cancel`, `pong`. Client→server messages use `action`, not `type`.

## Key Directories

|Path|Purpose|
|---|---|
|`/` (root)|All backend code as single files; no `src/`|
|`public/`|`index.html` (entire dashboard UI incl. inline JS) + `index.css` (glassmorphism dark theme)|
|`camofox-browser/`|Git clone of <https://github.com/jo-inc/camofox-browser> installed by `setup.sh`; the Camoufox build lives in `camofox-browser/.camoufox/` (that is `CAMOUFOX_INSTALL_DIR`). Not edited — upstream code|
|`camofox-data/`|Runtime browser state, all local: `profiles/` (one dir per session, name = `sha256(userId)` truncated to 32 hex), `cookies/`, `uploads/`, `traces/`|
|`warp/`|warp-go source (cloned) + its compiled `warp` binary + `reg.json` (WARP device key) + `reg.json.<timestamp>.bak` rotation backups|
|`psiphon/`|`psiphon-tunnel-core-x86_64` + the `psiphon.config` written per run from the root template|
|`dropbox-app/`|Official Dropbox daemon (`.dropbox-dist/dropboxd`). The daemon's `HOME` is pinned here, so `.dropbox/` (device state) and `Dropbox/` (sync folder) stay inside the project. `register.js` also strips `DISPLAY`/`WAYLAND_DISPLAY`/`DBUS_SESSION_BUS_ADDRESS` from its env: with a display, daemon 278.x opens a GUI window (its bundled Firefox) and prints **nothing** to stdout, so the `cli_link_nonce` URL never appears and the step always times out. **One account = one device identity**: `linkDaemonAndVerifyEmail` deletes `.dropbox/` and `Dropbox/` before every spawn (`[dropboxd] State lama dihapus …`) — a host_id that is already linked never prints a `cli_link_nonce` again, so without the reset every account after the first degrades to `VERIF`|
|`.toolchain/`|Go toolchain that `setup.sh` downloads when the host has none (only used to build warp-go)|
|`data/`|Debug/error screenshots|

## Development Commands

```bash
./setup.sh                                  # installs EVERYTHING into this directory:
                                            # npm deps, camofox-browser (+ Camoufox into
                                            # .camoufox/), warp-go (clones + builds; Go is
                                            # auto-downloaded to .toolchain/ if missing),
                                            # psiphon binary, dropbox daemon, apt packages
./warp/warp -reg                            # one-time WARP registration → warp/reg.json
node server.js                              # dashboard on :3000 (override with PORT=)
node register.js --proxy=false --init=false # CLI mode
```

There is no build step, no bundler, no transpiler for our code: `public/` is served statically, JS is CommonJS. `camofox-browser/` is installed with `npm install --omit=dev` — its dev dependency `openclaw` refuses Node < 24.16 and would abort the install; the REST server needs no dev deps.

## Code Conventions & Common Patterns

- **Module style**: CommonJS (`require`/`module.exports`), `"type":"commonjs"`. One concern per root file; `register.js` self-runs via `if (require.main === module)`.
- **No formatter/linter/tsconfig** — match the surrounding file (4-space indent, semicolons, single quotes). Do not introduce tooling.
- **Never hardcode DOM selectors inline.** Every interaction goes through the selector catalogue: `getSelectors('email_field' | 'continue_button' | 'first_name' | 'last_name' | 'password' | 'tos_checkbox' | 'submit_button' | 'captcha' | 'verify_email' | 'send_email' | 'resend_email' | 'cli_login_email' | 'cli_login_password' | 'cliLink')` — each key is an **array**; an empty result means the in-code fallback list is used — then the tolerant helpers `cf.findVisible(list)` / `cf.waitForVisible(list, ms)` / `cf.clickVisible(list)` / `cf.typeVisible(list, text)`, which try each entry in order. Most-specific → most-generic; that ordering *is* the recovery strategy when Dropbox changes markup. `selector.json` still carries object-shaped legacy keys from the Playwright engine (`register`, `settings`, `verifyEmail`, `accountSetup`, `finalPage`); nothing reads them.
  - camofox `/click` and `/type` accept Playwright selectors (`css`, `:has-text("…")`, `xpath=`) but **one selector at a time**, and the server has no visibility endpoint. So visibility checks go through `camofox-client.findVisible()`: one in-page script walks the catalogue, keeps visible elements, picks the smallest (never an enclosing container), and marks it with `data-cfx="1"`; the click/type then targets that unique node.
  - Catalogue seed: `selector.json` (tracked, but overwritten at runtime by `PUT /api/selectors`, which writes both `history.json` and `selector.json`). `register.js` caches it in-process → restart the server after editing on disk. `POST /api/selectors/reset` restores it.
- **camofox session model**: one `userId` per email (`dropbox-<localpart>-<random>`). `POST /tabs` **requires `sessionKey`** in camofox-browser ≥1.17 (it is only a tab-group label; we pass the `userId`). `DELETE /sessions/:userId` destroys tabs and drops the persisted profile dir — that is how a fresh account gets a fresh identity.
- **Daemon linking has three non-obvious rules** (`linkDaemonAndVerifyEmail`): (1) *one device identity per account* — `.dropbox/` and `Dropbox/` under `dropbox-app/` are deleted before every `dropboxd` spawn, because a linked host never prints the cli_link URL again and every later account would then degrade to `VERIF`; (2) *the nonce is not single-use* — the daemon keeps reprinting the **same** `cli_link_nonce` while unlinked, so a retry re-opens the same URL rather than waiting for a new one; (3) *the cli_link page can be Dropbox's login form* (the tab's session dropped, e.g. the exit IP changed mid-flow; proof: `data/debug_error_cli_confirm_*.png` showing "Masuk" + an Email field instead of the Connect button) — `ensureDropboxLogin()` detects that by an email field being visible, re-authenticates with the account's email + password (`cli_login_email` / `cli_login_password`), and only then looks for the Connect button. Failures save `data/debug_error_cli[_confirm]_<localpart>.png` and log the page's visible text. `killDropboxDaemon()` kills `DROPBOX_DIST` (`.dropbox-dist`), not `dropboxd`, because the launcher exec()s into `dropbox-lnx.x86_64-<ver>/dropbox`.
- **Failure signaling is string-matched across the module boundary** — treat these as a contract:
  - `throw new Error('BROWSER_KILL_REQUIRED: …')` → `server.js` strips the prefix, restarts the browser/tunnels as needed, retries or moves to the next phase.
  - `throw new Error('NO_URL_CHANGE')` → soft failure inside the step loop: reload the tab and retry the step (`maxTabAttempts`) before escalating.
  - `checkTooManyAttempts()` throws `'BROWSER_KILL_REQUIRED: Too many attempts…'` → `server.js` `break`s the phase loop immediately to rotate the exit IP.
- **Return shape**: `registerSingleEmail()` resolves `{ success, status, password, ip, ua }` where `status` is `'success'` (verification email confirmed) or `'VERIF'` (account created, unverified). `VERIF` is a success in `history.json` but counted separately (`verifCount`) in the UI.
- **Timeout units are seconds everywhere** — UI inputs, `db.js` defaults, `server.js` fallbacks, and `selector.json`'s `defaults`. `registerSingleEmail` converts: `const gtMs = globalTimeout * 1000`. Typical values: `globalTimeout` 30–90, `daemonTimeout` 120.
- **Exit paths are keyed by fixed loopback ports**, not config: `warp` → `socks5://127.0.0.1:40000` (`./warp/warp -l 127.0.0.1:40000`), `psiphon` → `socks5://127.0.0.1:3080` (generated from `psiphon.config`), `socks5` → user host. Because camofox pins its proxy at process start (`PROXY_HOST`/`PROXY_PORT` env), `camofox-manager` compares a `specKey` of `[proxy, visible, port]` and restarts the browser server whenever the requested exit changes — the browser is *not* restarted per email.
- **IP rotation semantics**: WARP rotation deletes `warp/reg.json`, runs `./warp/warp -reg` (a new device key ⇒ a different Cloudflare egress), then relaunches with `-l`; the old key is kept as `reg.json.<ts>.bak`. Psiphon rotation restarts the tunnel and picks an unused `EgressRegion` from `global.psiphonRegions` (tracking `global.psiphonUsedRegions`). `register.js` passes `rotate: isRetry || global.warpRotateNext`; the UI exposes both as 🔄 buttons on `POST /api/proxy/rotate` (409 while a batch is running, because rotating would pull the proxy out from under the open tab).
- **Exit-IP proof is one shared endpoint list** — `proxy-manager.EXIT_IP_ENDPOINTS` (`cdn-cgi/trace` → `api.ipify.org` → `ifconfig.me`), each `{ url, parse(text) → {ip, warp?} | null }`. `startWarp()` walks it *through the SOCKS tunnel* (3 rounds) before declaring WARP healthy, and the log line `[Warp] ✓ WARP aktif — exit IP: … (cdn-cgi/trace warp=on)` is the proof the traffic really left via WARP. `register.js`'s preflight re-reads the same list **inside the browser tab** (tab created on `EXIT_IP_ENDPOINTS[0].url`, later endpoints via `cf.navigate`), because camofox — not the proxy manager — is what must have the proxy applied. Never hardcode a bare ipify call: for a WARP egress range Cloudflare often answers a challenge page (HTML), which parses to nothing and once killed a perfectly working tunnel. A page that yields no IP is a failure to report, never a value to store.
- **Anti-detection is delegated to Camoufox** — no `userAgent` override, no UA pools, no persistent Firefox profile, no `navigator.webdriver` patches in our code. Keep `useHeadless`/visible handling and the per-userId profile isolation instead.
- **Visible mode** (`useHeadless:false`, UI "Tampilkan Browser"): `camofox-manager` starts the server with `ENABLE_VNC=1`, `VNC_PORT=5902`, `NOVNC_PORT=6082` (camofox VNC plugin); a human solves CAPTHA at `http://localhost:6082`. It also clears `LD_LIBRARY_PATH` for the child: a CUDA `libOpenCL.so.1` earlier on the loader path kills Camoufox renderers right after tab creation (upstream `start-clean.sh` does the same).
- **Logging**: prefix log lines with a bracketed subsystem tag (`[Warp]`, `[Psiphon]`, `[dropboxd]`, `[Camofox]`, `[Langkah N]`, `[Worker]`, `[Kill]`, `[Selector]`) — the UI colors them. `server.js` hijacks `console.log/error/warn` and forwards JSON-serialized args to the WS, so **never pass an `Error` object as a log argument** (it serializes to `{}`); interpolate `error.message`. Use `global.safeSend({ type:'preview'|…, … })` for non-text streams.
- **Naming**: `camelCase` functions/locals; `UPPER_CASE` for path/port constants (`DROPBOX_DAEMON`, `DAEMON_HOME`, `PSIPHON_BIN`, `WARP_BIN`, `WARP_REG`, `DATA_DIR`); `<snake_case>` keys in `selector.json`; `temp_*.js` = scratch copies kept for diffing against the live file (`temp_register_webui2.js`, `temp_register_1160a43.js` — the old Playwright engine) — nothing imports them.
- **Settings contract** (`db.js` defaults ⇄ `POST /api/settings/apply` ⇄ UI): `aliasWorker`, `urlDropbox`, `emailSource`, `domainEmail`, `count`, `passwordMode`, `fixedPassword`, `globalTimeout`, `globalRetry`, `daemonTimeout`, `useHeadless`, `socks5Host`, `warpPort`, `useDirect`, `useWarp`, `useSocks5`, `usePsiphon`, `psiphonRegions`, `idleTimeout`, `debugProxy`. UA-related fields (`uaMode`, `deviceTypes`) were removed with Playwright.

## Important Files

|File|Role|
|---|---|
|`server.js`|Express 5 + `ws` server: REST + WS API, batch loop, phase rotation, worker status, log/preview streaming. REST surface: `GET/DELETE /api/history`, `GET /api/proxy/status`, `POST /api/proxy/rotate`, `GET|POST /api/worker-stat*`, `GET /api/settings`, `POST /api/settings/apply`, `GET|PUT /api/selectors`, `POST /api/selectors/reset`. Port: `process.env.PORT \|\| 3000`|
|`register.js`|Automation engine: `registerSingleEmail()` is the only entry point the server uses; `ensureExitPath()`, `linkDaemonAndVerifyEmail()`, `run()` is the CLI. Also exports `getRandomName`|
|`camofox-manager.js`|Single-instance supervisor for `./camofox-browser/server.js`: env (ports, `CAMOUFOX_INSTALL_DIR`, `CAMOFOX_PROFILE_DIR`, proxy, VNC), start/stop with process-group kill, `specKey` restart-on-change, scoped `pkill` cleanup, `status()` for the UI|
|`camofox-client.js`|Thin `http` REST client for one session: `createTab` (needs `sessionKey`), `navigate`, `settle`, `evaluate`, `findVisible`/`clickVisible`/`typeVisible` (the marked-node trick), `screenshot`, `destroy`|
|`proxy-manager.js`|`startWarp`/`startPsiphon`/`stopAll`, `reRegisterWarp`, `socksExitIp` (SOCKS preflight), `checkPort`, `status()`, `wrapX64Binary`-free direct spawns. Constants: `DEFAULT_WARP_PORT = 40000`, `PSIPHON_PORT = 3080`|
|`db.js`|JSON-file store. `history.json` holds `registrations[]`, `settings{}`, `selectors{}`; seeds defaults on first read; `resetSelectors()` re-syncs from `selector.json`|
|`selector.json`|Selector catalogue seed + per-step budgets (`defaults.globalTimeout`, `maxTabAttempts`, `maxCliAttempts`, `maxVerifAttempts`, `maxSetupAttempts`, `maxFinalAttempts`)|
|`public/index.html`|Full dashboard: Progress tab (ring, stats, colored console, live preview), Pengaturan tab (persisted settings, engine status panel, 🔄 WARP / 🔄 Psiphon rotation), Selector tab (live editor)|
|`setup.sh`|Environment installer, x86_64-only: project `npm install`, `git clone` camofox-browser + `npm install --omit=dev` with `CAMOUFOX_INSTALL_DIR` pointed inside the project, clone+build warp-go (Go from `go.dev/VERSION` into `.toolchain/` if the host has none), Psiphon binary, Dropbox tarball, apt package list (upstream Camoufox deps + xvfb/x11vnc/novnc/websockify + build-essential/python3 for `better-sqlite3`)|
|`psiphon.config`|Template `psiphon-tunnel-core` config: SOCKS listener `127.0.0.1:3080`, `UseIndistinguishableTLS`. `proxy-manager` copies it to `psiphon/psiphon.config` per run with a chosen `EgressRegion`|
|`test.txt`|Canonical test inputs (two referral URLs + local parts) used by the QA runs below|

## Runtime/Tooling Preferences

- **Node.js + npm only**; `package-lock.json` is the lockfile. Runtime deps: `express` 5, `ws`, `socks-proxy-agent`. `playwright`, `@playwright/test`, `proxifly`, `top-user-agents` are gone — do not re-add them.
- **Ports in use** (all hardcoded in the manager modules): 3000 dashboard, **9379** camofox REST (deliberately not 9377/9378 so it cannot collide with an existing camofox instance), 40000 WARP SOCKS5, 3080 Psiphon SOCKS, 5902 VNC / 6082 noVNC.
- **Binaries are installed only by `setup.sh`** and executed only from inside this directory: `camofox-browser/` (git + `camoufox-js fetch`), `warp/warp` (git + `go build`), `psiphon/psiphon-tunnel-core-x86_64` (GitHub raw), `dropbox-app/.dropbox-dist/dropboxd` (dropbox.com tarball). System tools used at runtime: `git`, `curl`/`wget`, `tar`, `pkill`, and optionally `go`.
- **System packages** needed to actually run Camoufox / visible mode (printed by `setup.sh` step 8, auto-installed when run as root): Firefox libs (`libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 libegl1 libgl1-mesa-dri libgbm1 xvfb`), `x11vnc novnc websockify`, fonts, and `build-essential python3` so `better-sqlite3` compiles.
- Gitignored runtime state — a fresh clone starts from defaults; never commit results: `node_modules/`, `.toolchain/`, `camofox-browser/`, `camofox-data/`, `warp/`, `psiphon/`, `dropbox-app/`, `data/`, `history.json`, `selector.json`, `.agents`.

## Testing & QA

- `npm test` is the npm placeholder (`exit 1`); **no test files exist**. Do not claim coverage; do not add a suite unless asked.
- Verify changes by exercising the real path, cheapest first:
  1. `curl -s localhost:3000/api/proxy/status` → `camofox.installed/browserInstalled` true, `warp.registered`, current exit IPs. Same data is in the dashboard under **Pengaturan → Status Mesin Lokal**.
  2. Dashboard Progress tab: **2 emails** from `test.txt` (its referral URLs are the canonical test inputs), `Direct` **or** `Warp+Socks5`, `globalRetry: 1`, headless on. The console must show `[Camofox] ✓ Server siap di http://127.0.0.1:9379` → (WARP only) `[Warp] ✓ WARP aktif — exit IP: … (cdn-cgi/trace warp=on)` → `[Server] Public IP (via browser/…)` → `[Langkah 1..3]` → `[dropboxd] State lama dihapus (.dropbox/) …` → `[dropboxd] ✓ URL CLI Link ditemukan` → `[dropboxd] … This computer is now linked to Dropbox` → `✓ Pendaftaran success for <email>`, twice. Both records must be `success` in `history.json` — the second account is the regression check for the device-state reset (a linked host_id makes the daemon silent, which shows up as `[dropboxd] Timeout … URL cli_link tidak muncul` + `VERIF`). `VERIF` from a missing verify-email button is acceptable; a missing `cli_link_nonce` URL is not.
  3. `cat history.json` → new record with the expected `status`, `ip`, `ua`, `timeouts`, `errors`.
  4. Selector/DOM failures: edit in the **Selector tab** (persisted via `PUT /api/selectors`) rather than editing code, then re-run.
  5. Exit-IP changes: press 🔄 WARP / 🔄 Psiphon and confirm the printed `exit=` in the status panel actually changed (WARP rotation prints `[Warp] reg.json dihapus…` and creates `reg.json.<ts>.bak`).
- Interrupt behaviour is part of QA: press **Hentikan** mid-run and confirm no orphans — `pgrep -fa 'camofox-browser/server\.js|\.camoufox/camoufox-bin|Xvfb|x11vnc|novnc|websockify|\.dropbox-dist|psiphon-tunnel-core|warp -l'` returns nothing (note: `dropboxd` exec()s to `.dropbox-dist/dropbox-lnx.x86_64-<ver>/dropbox`, so match the dist directory, not the name `dropboxd`) — and the batch halts with `status:'stopped'`.
- Proxy/VPN tiers need a live network: `./warp/warp -reg` must have succeeded once, and "Too many attempts" from Dropbox is expected behaviour, not a bug — phase rotation/`rotate:true` is the intended remedy.
- If Camoufox starts but every page goes blank right after tab creation, suspect `LD_LIBRARY_PATH` (CUDA `libOpenCL.so.1`); `camofox-manager` clears it for the child process.
