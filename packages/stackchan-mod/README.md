# stack-chan MOD: Claude session status

`mod.js` connects to `ws://localhost:5777/v1/ws` (change `SERVER_URL` at the top; use the LAN IP on a real device), sends `hello`, and maps `display.expression` to a face emotion and `display.headline` to a balloon. It retries every 3 s after a close.

| server expression | face emotion          |
| ----------------- | --------------------- |
| neutral           | NEUTRAL               |
| focused           | ANGRY (narrowed eyes) |
| worried           | DOUBTFUL              |
| happy             | HAPPY                 |
| sad               | SAD                   |

`display.light` drives every LED in `robot.lighting.led`, rendered as sent so colours change server-side without a mod rebuild. Absent `light` turns the LEDs off.

| `light.mode` | effect                      |
| ------------ | --------------------------- |
| `rainbow`    | `lightRainbow`              |
| `solid`      | `lightOn(rgb)`              |
| `blink`      | `lightBlink(rgb, periodMs)` |

Valid emotions in stack-chan: NEUTRAL, ANGRY, SAD, HAPPY, SLEEPY, DOUBTFUL, COLD, HOT.

## Build (tested, macOS)

The SDK version must match the host firmware on the device (see Device). The root scripts install the whole toolchain into `<repo>/vendor` on first use (Moddable SDK 10.0.1, ESP-IDF v6.1, the stack-chan checkout and its `node_modules`; versions pinned in `scripts/toolchain.mjs`), so there is no manual SDK setup and no `MODDABLE` export.

```sh
bun install              # repo root: postinstall clones/pulls stack-chan into vendor/stack-chan
bun run device:deploy    # flash the vendored host firmware to the connected device
bun run mod:install      # build the MOD and flash it
```

To override the server URL without editing `mod.js`, use the package script (it always uses `vendor/`). It is named `mod:build`, not `build`, so `vp run -r build` / `bun run ready` do not need Moddable:

```sh
bun run mod:build -- --server-url ws://192.168.1.10:5777/v1/ws   # -> dist/stackchan-mod.xsa (gitignored)
bun run mod:build -- --server-url ws://192.168.1.10:5777/v1/ws --install   # also flash the connected device
```

`--install` auto-picks the only `/dev/cu.usbmodem*` port unless `--port` is given. The default URL is the Tailscale Funnel one (see Which URL).

Building a MOD needs only the SDK tools. ESP-IDF is installed only on `--install` / `device:deploy`, because flashing uses its `esptool`.

## Device

- Host version must equal the SDK version that built the `.xsa`. A mismatch fails `npm run mod` with `Incompatible Moddable version: A != B`. After `bun run device:deploy` the device runs `10.0.1+stackchan.1`; a device flashed earlier with a 9.0.0 host must be redeployed before `mod:install` works.
- Check the host version: read 256 bytes at flash `0x10000` and run `strings` on them; look for `x.y.z+stackchan.1`.

  ```sh
  esptool --chip esp32s3 --port /dev/cu.usbmodem* read-flash 0x10000 256 /tmp/app.bin && strings /tmp/app.bin | grep stackchan
  ```

- Serial port: `/dev/cu.usbmodem*`.
- Read the device log (`trace()` output): `bun run device:logs` (follow), `bun run device:logs -- --seconds 20` (bounded, for agents), `--port <path>` to pick a port. Stop it before `mod:install` / `device:deploy`; the port is exclusive. It reattaches after unplug or reset, so leave it running.
- Restart the device (hard reset via esptool; keeps firmware and MOD): `bun run device:restart`. A running `device:logs` keeps going and shows the ROM banner and full boot log (notices go to stderr as `[device:logs] ...`).
- The MOD is written to the `xs` partition at `0xfa0000`.
- Do not toggle DTR/RTS by hand. If the device hangs, recover with `esptool --chip esp32s3 --after hard-reset chip-id`.

## Which URL

`SERVER_URL` is baked into the `.xsa`; rebuild to change it.

| URL                                 | Status                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws://<mac-lan-ip>:5777/v1/ws`      | Works (device connected). The LAN IP is DHCP; rebuild if it changes.                                                                                                 |
| `wss://mpro.dwelf-koi.ts.net/v1/ws` | Tailscale Funnel: HTTPS on 443, proxies to `127.0.0.1:5777`; reachable. A device connection over wss was NOT observed. TLS in a MOD on the 9.0.0 host is unverified. |
| `ws://<name>.ts.net/v1/ws`          | Cannot work: port 80 is not served and the device is not on the tailnet.                                                                                             |

## Browser simulator

```sh
cd vendor/stack-chan/web && npm ci
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
