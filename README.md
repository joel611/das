# stack-chan-server

A personal Mac setup that watches my Claude Code sessions across all my projects, shows their state on a [stack-chan](https://github.com/stack-chan/stack-chan) robot and a desktop dashboard, and starts new sessions from a spoken or typed request.

## Components

**CLI daemon** (`packages/cli`): `bun run daemon --bg`

- Spawns the local server, scans projects, tracks Claude sessions through hooks, and runs the voice router.
- Serves the HTTP and WebSocket API for the desktop app and devices.

**Desktop** (`packages/desktop`): `bun run desktop`

- Tray icon in the macOS menu bar: daemon status, open dashboard, quit.
- Dashboard window: overview of sessions, projects and devices.
- Settings, hook installer, and a console to send a typed command to the daemon.

**Device** (`packages/stackchan-mod`): the stack-chan robot

- A MOD that connects to the daemon and shows state on the robot's face.

## Folder structure

```
packages/
  cli/               daemon (Bun): scanner, sessions, voice router, API
  desktop/           Tauri app: src-tauri (Rust tray), src (Vite+ React, Tailwind, shadcn/ui)
  stackchan-mod/     stack-chan MOD, plus sim-spike/ (Moddable simulator experiment)
plugins/
  stack-chan-hooks/  Claude Code plugin: hooks that forward session events to the daemon
.claude-plugin/      marketplace.json, so `claude plugin` can install from this repo
docs/                product notes
```

The workspace is a [Vite+](https://viteplus.dev) monorepo (`vite-plus` provides `vp`: tasks, lint, format, build).

## Commands

```sh
bun install

bun run daemon --bg      # start the daemon in the background (also: --stop, --status; no flag = foreground)
bun run desktop          # menu bar app + dashboard in dev mode (tauri dev)
bun run hooks:install    # install the Claude Code hook plugin (also: hooks:uninstall, hooks:status)
bun run dev              # daemon (watch) + tauri desktop in parallel (vp run -r --parallel dev:all)

bun run test             # vp run -r test  (the daemon's bun tests)
bun run check            # vp check: format, lint, type-check
```

In an interactive shell `vp` may be aliased to something else; the scripts above call the project-local `vp`.

## Typical setup

1. `bun install`, then `bun run daemon --bg`.
2. `bun run desktop`. Tray icon, "Open Dashboard", Settings: set the root folders and the OpenRouter key, then Save.
3. Click "Install hooks" (or `bun run hooks:install`). This installs the `stack-chan-hooks` Claude Code plugin from this repo; running Claude sessions need a restart or `/reload-plugins` to load it. `bun run hooks:uninstall` removes it.
4. Run `claude` once in each root folder and accept the trust dialog, so voice spawns work (the Settings tab lists untrusted projects).

Details: [`packages/cli/README.md`](packages/cli/README.md) (API, protocol, voice router, hooks), [`packages/desktop/README.md`](packages/desktop/README.md), [`packages/stackchan-mod/README.md`](packages/stackchan-mod/README.md).
