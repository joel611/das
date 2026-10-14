# stack-chan MOD: Claude session status

`mod.js` connects to `ws://localhost:5777/v1/ws` (change `SERVER_URL` at the top; use the LAN IP on a real device), sends `hello`, and maps `display.expression` to a face emotion and `display.headline` to a balloon. It retries every 3 s after a close.

| server expression | face emotion          |
| ----------------- | --------------------- |
| neutral           | NEUTRAL               |
| focused           | ANGRY (narrowed eyes) |
| worried           | DOUBTFUL              |
| happy             | HAPPY                 |
| sad               | SAD                   |

Valid emotions in stack-chan: NEUTRAL, ANGRY, SAD, HAPPY, SLEEPY, DOUBTFUL, COLD, HOT.

## Build (tested, macOS)

```sh
git clone --depth 1 -b 9.5.0 https://github.com/Moddable-OpenSource/moddable.git ~/Developer/moddable-9.5.0
export MODDABLE=~/Developer/moddable-9.5.0
export PATH=$MODDABLE/build/bin/mac/release:$PATH
make -C $MODDABLE/build/makefiles/mac

git clone --depth 1 -b develop https://github.com/stack-chan/stack-chan.git ~/Developer/stack-chan
cd ~/Developer/stack-chan/firmware && npm ci
npm run mod:build -- <this-repo>/packages/stackchan-mod/manifest.json --mode=release
# -> firmware/dist/bin/esp32/release/stackchan-mod/stackchan-mod.xsa (2 KB, copied here)
```

Only the SDK tools are needed; no ESP-IDF or Emscripten for building a MOD. Install the `.xsa` on a device with `npm run mod -- <manifest>`.

## Browser simulator

```sh
cd ~/Developer/stack-chan/web && npm ci
# the simulator needs mc.js / mc.wasm; fetch the published ones instead of building with Emscripten
curl -fo simulator/mc.js   https://stack-chan.github.io/stack-chan/web/simulator/mc.js
curl -fo simulator/mc.wasm https://stack-chan.github.io/stack-chan/web/simulator/mc.wasm
npx vite --port 5173 --host 127.0.0.1     # open http://127.0.0.1:5173/simulator/
```

Add MOD (file input), click Add MOD, the archive is applied and the simulator restarts.

## Result: the WASM simulator cannot run this MOD

The mod installs, but the host logs `MOD override unavailable: module "WebSocket" not found`. A probe MOD showed the WASM host has no network at all: no `globalThis.WebSocket`, `fetch`, or `device`, and no `WebSocket`, `websocket`, `socket`, `http`, `net`, or `embedded:network/*` modules. The WASM manifest (`firmware/host/platforms/wasm`) does not include any network module, and no JS bridge to the browser's WebSocket exists. This is not a mixed-content or CORS issue; the code never gets to open a socket.

The face and balloon mapping was verified in the simulator with a timer-driven variant of the mod (cycling focused, worried, happy, sad, neutral with headlines): the face changed and the balloon text showed. The simulator exposes A/B/C buttons and a camera, and a mic path through the audio bridge, but no way to push data in from outside.

To drive it from the server you would need one of: a real device (CoreS3 has WebSocket), a custom WASM host build with a Moddable-to-browser WebSocket bridge, or a host-side change that exposes browser `WebSocket`/`fetch` to MODs.
