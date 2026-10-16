---
name: verify-das-desktop
description: Launch and drive the DAS / Stack-chan desktop app (Tauri v2 menu-bar app + React dashboard in packages/desktop) with the repo's WebdriverIO e2e harness and capture screenshot and file-state evidence. Use to prove a desktop UI, Tauri relay, settings, tray or window change works on macOS.
---

# Verify the DAS desktop app

Surface: macOS Tauri window (WKWebView) over the Bun daemon (`packages/cli/src/daemon.ts`). Driver: WebdriverIO via `@wdio/tauri-service` with the **embedded** WebDriver (`e2e` Cargo feature), because `tauri-driver` does not work on macOS. macOS only; the other platforms are unverified. The harness is already in `packages/desktop/e2e/`; this skill wraps it.

All commands run from the repo (or worktree) root. Helper: `.claude/skills/verify-das-desktop/scripts/verify.sh`.

## Launch

```sh
.claude/skills/verify-das-desktop/scripts/verify.sh run                  # all specs
.claude/skills/verify-das-desktop/scripts/verify.sh run e2e/settings.e2e.ts   # subset (paths relative to packages/desktop)
```

It builds the debug binary (`tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`, `VITE_E2E=1`; a few seconds when warm, minutes cold) then runs WDIO. WDIO starts the app itself; there is no server for you to keep alive. Ready = `Spec Files: N passed` in the output and exit 0.

Empty data dir is the default: `onPrepare` in `e2e/wdio.conf.ts` calls `createSandbox()` (`e2e/fixture.ts`): temp `DAS_CONFIG_DIR` (with a `config.yml` holding one root), `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, a free `PORT`, `TOKEN=e2e-token`, exported via env to workers, the app and the daemon. Real `~/.config/das` and `~/.claude` are never touched. Specs that need the daemon call `startDaemon()` / `stopDaemon()` from `fixture.ts`; without it the app is in the offline state.

## Doctor

```sh
.claude/skills/verify-das-desktop/scripts/verify.sh doctor
```

Read-only: macOS, bun, cargo, deps, e2e binary exists and is newer than `src/` and `src-tauri/src/` (stale binary = you would verify old code; run `run` to rebuild), warns if some `stack-chan-app` is already running. Never kill that one: it may be the user's tray app.

## Drive

Write throwaway specs in `packages/desktop/e2e/scratch/<name>.e2e.ts` (a subfolder, so the default `./*.e2e.ts` glob and `bun run desktop:e2e` ignore it) and run with `verify.sh run e2e/scratch/<name>.e2e.ts`. Delete them after, or promote to `e2e/*.e2e.ts` if they should stay as regression tests. Pattern, copied from `e2e/settings.e2e.ts`:

```ts
import { $, browser, expect } from "@wdio/globals";
import { startDaemon, stopDaemon } from "../fixture.ts";
let daemon;
before(async () => { daemon = await startDaemon(); await browser.refresh(); }); // app polls slowly; refresh sees the new daemon
after(() => stopDaemon(daemon));
```

Stable handles (verified in `src/`):

| What | Selector |
| --- | --- |
| App title | `h1` text `DAS` |
| Tab nav | `nav[aria-label="Views"]` then `.$("button=Settings")`; tabs: Command, Overview, Console, Debug, Serial, Settings; active has `aria-current="page"` |
| Daemon chip | `[role="status"]` text `daemon online · …` or `daemon not running` |
| Settings fields | `#roots` (textarea, one folder per line), `#port`, `#token`, `#key`; save `button=Save`; toast `[data-sonner-toast]` contains `Saved.` |
| Hooks | `button=Install hooks` / `Reinstall hooks` / `Uninstall hooks`; omp: `Install omp extension` / `Uninstall omp extension` |
| Jev style | `[role="group"][aria-label="Jev animation style"]` buttons, `aria-pressed` |
| Command (Jev) | input `#jev-cmd`, submit `button[aria-label="Send to Jev"]`, log `[role="log"]`, confirm `[role="alertdialog"][aria-label="Confirm real request"]` |
| Console | textarea placeholder `Type a request…`, `#dry` checkbox (dry run, on by default), `button=Send`, `button=New conversation` |
| Tauri IPC | `browser.execute(() => window.__TAURI__.core.invoke("api", {method, path, body}))`; window API via `window.__TAURI__.window.getCurrentWindow()` (only with the e2e config's `withGlobalTauri`) |

Daemon side effects are checked directly: read files under `process.env.DAS_CONFIG_DIR`, or `fetch("http://127.0.0.1:"+process.env.PORT+"/v1/state", {headers:{Authorization:"Bearer e2e-token"}})`.

Not drivable: the tray icon / menu-bar menu (native NSStatusItem, outside the WebView). Verify tray state only through the daemon state it renders from, and say it was not observed visually.

## Evidence

Proof standard: drive the real UI path (click, type) not `invoke` shortcuts, unless the feature IS the relay. Capture the action and the resulting state: `await browser.saveScreenshot("./e2e/<feature>-before.png")` and `-after.png` (cwd is `packages/desktop`), plus the side effect (config file contents, daemon response, window visibility). Assertions in the spec are the pass/fail record; screenshots are the picture.

`verify.sh run` copies `e2e/*.png` to `$EVIDENCE_DIR` (default `~/.cache/das-verify/<timestamp>/`, outside the repo; `e2e/*.png` is gitignored) and prints the path. Report that path, the spec output, and any side-effect check. Dry run caveat: Console / Jev dry run still calls the router (OpenRouter) and needs a key; the sandbox has none, so a dry-run send returns an error reply there. Verify that behavior, do not fake a key.

## Cleanup

WDIO stops the embedded driver and the app on exit; each spec stops its own daemon in `after`. After a **failed or killed** run check for strays you started: `pgrep -fl "das-e2e-|daemon.ts|stack-chan-app"`, kill only PIDs you recognize as yours from this run (sandbox dirs are `${TMPDIR}das-e2e-*`; match on that path, never on the bare process name, the user may run the real tray app). Remove your `e2e/scratch/` specs. Evidence in `$EVIDENCE_DIR` is kept.

## Isolation

Sandbox env makes it safe next to the user's real daemon and tray app (random port, temp dirs). `maxInstances: 1`: do not run two `verify.sh run` at once in the same checkout (they share `e2e/*.png` and `target/debug`).

## Feature map

See `features/README.md`. A proof that touches one tab is incomplete when the change affects others in the map.
