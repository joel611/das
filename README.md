# stack-chan-server (command center)

A desktop command center that runs as a local daemon. It manages my Claude Code sessions across projects and exposes an API to external devices. The first supported agent is Claude Code, and the first supported device is [stack-chan](https://github.com/stack-chan/stack-chan).

The command center owns its own classifier and LLM for reasoning. A request (spoken or typed) is first classified by intent, then delegated to the right agent or workflow.

## Direction

- **Desktop + daemon**: the product is a macOS desktop app (Tauri) on top of a long-running daemon (Bun). The daemon is the command center; the desktop app is its dashboard and control surface.
- **Main use case**: manage Claude Code sessions (watch state, start new sessions from a request) and expose that through an API for external devices.
- **Own classifier and LLM**: intent classification and routing run inside the command center (today via OpenRouter), not inside any one agent.
- **Later**: more coding agents for coding tasks, and non-coding tasks such as Home Assistant and MCP servers. The classifier decides whether a request is a coding task, a home task, and so on, and delegates to a specific agent or workflow.
- **Devices**: stack-chan is the only device with first-party support for now. Any IoT device that can speak HTTP and WebSocket can connect to the API.

Status: Claude Code and stack-chan work today. Other agents, workflows and the Home Assistant / MCP integrations are planned. See [`docs/product.md`](docs/product.md).

## Components

**Daemon / command center** (`packages/cli`): `bun run daemon --bg`

- Scans projects, tracks Claude sessions through hooks, and runs the classifier/router.
- Serves the HTTP and WebSocket API for the desktop app and devices.

**Desktop** (`packages/desktop`): `bun run desktop`

- Tray icon in the macOS menu bar: daemon status, open dashboard, quit.
- Dashboard window: overview of sessions, projects and devices.
- Settings, hook installer, and a console to send a typed command to the command center.

**Device client** (`packages/stackchan-mod`): the stack-chan robot

- A MOD that connects to the daemon and shows state on the robot's face. It is the reference client for the device API.

## Folder structure

```
packages/
  cli/               daemon (Bun): scanner, sessions, classifier/router, API
  desktop/           Tauri app: src-tauri (Rust tray), src (Vite+ React, Tailwind, shadcn/ui)
  stackchan-mod/     stack-chan MOD, plus sim-spike/ (Moddable simulator experiment)
docs/                product notes
```

The workspace is a [Vite+](https://viteplus.dev) monorepo (`vite-plus` provides `vp`: tasks, lint, format, build).

## Commands

```sh
bun install

bun run daemon --bg      # start the daemon in the background (also: --stop, --reload, --status; no flag = foreground)
bun run desktop          # menu bar app + dashboard in dev mode (tauri dev)
bun run dev              # daemon (watch) + tauri desktop in parallel (vp run -r --parallel dev:all)

bun run test             # vp run -r test  (the daemon's bun tests)
bun run check            # vp check: format, lint, type-check
```

Settings live in `~/.config/das/config.yml` (override the dir with `DAS_CONFIG_DIR`). Logs are in `~/.config/das/logs/` (`ws.log` for WebSocket traffic, `api.log` for HTTP requests); `daemon.log` next to the config holds the raw output of `--bg`. `daemon --reload` re-reads the config. Details: [`packages/cli/README.md`](packages/cli/README.md).

In an interactive shell `vp` may be aliased to something else; the scripts above call the project-local `vp`.

## Typical setup

1. `bun install`, then `bun run daemon --bg`.
2. `bun run desktop`. Tray icon, "Open Dashboard", Settings: set the root folders and the OpenRouter key, then Save.
3. Click "Install hooks". Running Claude sessions need a restart to load them.
4. Run `claude` once in each root folder and accept the trust dialog, so spawned sessions work (the Settings tab lists untrusted projects).

## Flashing a stack-chan

Contributors need no manual SDK setup. The first `device:*` or `mod:*` command installs the toolchain into `vendor/` (ignored by VCS: stack-chan firmware, Moddable SDK, ESP-IDF; about 3 GB, one time). Nothing is written to `$HOME` or a shell profile. Needs Xcode command line tools, `node` and `python3`.

```sh
bun install                 # vendors stack-chan into vendor/stack-chan
bun run device:deploy       # flash the vendored firmware (host) to the USB device
bun run mod:install         # build the MOD and flash it (run after device:deploy)
bun run device:setup        # only install the toolchain, flash nothing
```

`device:deploy` replaces the host firmware, and the MOD with it, so run `mod:install` afterwards. Pass `-- --port /dev/cu.usbmodemXXXX` when more than one device is connected. The Moddable and ESP-IDF versions are pinned in `scripts/toolchain.mjs`.

## Connecting a device

Any device that can make HTTP requests and open a WebSocket can use the API: connect to `WS /v1/ws`, send `hello`, receive `snapshot` and `delta` frames, and send transcripts or commands over `POST /v1/voice` (or the socket). Speech-to-text stays on the device side. Protocol details are in [`packages/cli/README.md`](packages/cli/README.md).

Details: [`packages/cli/README.md`](packages/cli/README.md) (API, protocol, router, hooks), [`packages/desktop/README.md`](packages/desktop/README.md), [`packages/stackchan-mod/README.md`](packages/stackchan-mod/README.md).
