# Moddable simulator spike

Question: can a client running in a local Moddable simulator (separate desktop process) talk to this server over WebSocket?

**Answer: yes.** `ws-client` ran in `mcsim` (Moddable's Mac simulator), sent `hello`, received `snapshot`, then a `delta` after a fired hook. Seen through `tap.ts`, a logging proxy.

## Setup (one time)

```sh
git clone --depth 1 https://github.com/Moddable-OpenSource/moddable.git ~/Developer/moddable
export MODDABLE=~/Developer/moddable
export PATH=$MODDABLE/build/bin/mac/release:$PATH   # needed, or the build fails with "xsc: No such file"
make -C $MODDABLE/build/makefiles/mac
```

Needs full Xcode (tested with Xcode 27). Output lands in `$MODDABLE/build/bin/mac/release` (`mcsim.app`, `xsbug.app`, `mcconfig`).

## Run

```sh
bun run daemon                        # real server, :4321
bun packages/stackchan-mod/sim-spike/tap.ts                  # optional logging proxy, :4322 -> :4321
mcconfig -d -m -p mac -o /some/dir -m packages/stackchan-mod/sim-spike/ws-client/manifest.json   # builds and launches mcsim + xsbug
curl -X POST localhost:4321/hooks/PreToolUse -d '{"session_id":"s","cwd":"/path/in/a/project","tool_name":"Edit"}'
```

`ws-client/main.js` points at `:4322` (the tap). Change `port` to `4321` to talk to the server directly.

## Findings

- `trace()` output goes to the xsbug GUI console, not stdout. Use `tap.ts` to observe traffic headlessly.
- The Mac simulator opens real TCP sockets, so WebSocket to a LAN server works.
- The classic `websocket` module prints "ECMA-419 WebSocket Client recommended". Real stack-chan mods use `import WebSocket from 'WebSocket'` (see `cheerup_ws` example in the stack-chan repo).
- This app is a bare Moddable app, not a stack-chan mod. The stack-chan host (face, servo, audio via `robot.face.setEmotion`, `robot.motion.setPose`, `robot.audio.say`) runs on ESP32 boards or the browser WASM simulator. No native desktop host exists, as far as the stack-chan firmware docs show.

## Next

Milestone 3 options:

1. Build the real mod against stack-chan's browser WASM simulator (face and emotion visible).
2. Keep this desktop simulator for a protocol-level client with a simple Piu UI.
