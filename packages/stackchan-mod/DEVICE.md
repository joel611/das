# Device API: `StackchanContext`

What the firmware hands a MOD in `onContextCreated(robot, option)`. `mod.js` names the first argument `robot`. This file lists every capability, with the exact behaviour taken from the host TypeScript (not the prose docs).

Sources, all under `vendor/stack-chan/firmware/host/`:

| Topic | File |
| --- | --- |
| Types (the contract) | `app/capabilities.ts` |
| Implementation | `app/runtime-context.ts`, `runtime-audio.ts`, `runtime-ui.ts`, `runtime-lighting.ts`, `runtime-input.ts`, `runtime-camera.ts` |
| Motion | `modules/motion/motion-controller.ts`, `m5stackchan-servo-driver.ts`, `m5stackchan-servo.ts` |
| Face | `modules/ui/state/face-state.ts` |
| Prose docs | `../docs/api.md`, `../docs/local-peer-communication.md` |

Which of these `mod.js` uses today is marked **(used)**.

## Shape

`StackchanContext = StackchanCapabilityNamespaces & StackchanLegacyFlatCapability`.

- **Namespaced** (use these): `face`, `motion`, `audio`, `i18n`, `input`, `lighting`, `camera`, `conversation`, `connectivity`, `lifecycle`, `ui`.
- **Legacy flat** methods (`robot.say`, `robot.lookAt`, `robot.showBalloon`, `robot.setEmotion`, `robot.lightOn`, `robot.button`, ...) are compatibility shims that call the same code. Deprecated for new code. `mod.js` uses `robot.showBalloon` / `robot.hideBalloon` / `robot.face.*` / `robot.motion.*` / `robot.lighting.*` / `robot.audio.tone`; `showBalloon`/`hideBalloon` here are the flat forms (the namespaced forms are `robot.ui.showBalloon` / `robot.ui.hideBalloon`, same behaviour).
- Optional hardware shows up as `undefined`. Check before use.

Error conventions (from `docs/api.md` and the runtimes):

- Async commands **reject** on failure (`motion.setPose`, `motion.setTorque`, `audio.tone`, `audio.record`).
- `audio.say` / `audio.sing` **never reject**; they resolve a `Maybe<string>`: `{success: true, value}` or `{success: false, reason}`.
- `audio.playAudio` resolves `true` / `false`.
- Bad arguments to synchronous setters **throw** (`face.setEyeOpen`, `face.setMouthOpen`).
- Lighting calls on an unknown LED name are **silent no-ops**.

Shared types: `Vector3 = [x, y, z]` (metres). `Pose = {position: {x,y,z}, rotation: {y,p,r}}` (radians). `Maybe<T> = {success: true, value: T} | {success: false, reason?: string}`.

### Coordinate system

Right-handed, units metres and radians. Face forward: +X front, +Y left, +Z head side. Yaw `y` positive = look left, pitch `p` positive = **look down**, roll `r` positive = head tilts clockwise as seen from Stack-chan. So "tilt up by `u`" is `p: -u` **(used, `settleTilt`)**.

---

## `face` (FaceCapability)

State is held in the UI runtime and pushed to the face renderer every 33 ms (`INTERVAL_FACE = 1000/30`). Updates are skipped while the context is paused.

| Method | Behaviour |
| --- | --- |
| `setEmotion(emotion: Emotion)` **(used)** | Sets the emotion. `Emotion` is a numeric enum: `NEUTRAL 0, ANGRY 1, SAD 2, HAPPY 3, SLEEPY 4, DOUBTFUL 5, COLD 6, HOT 7`. Get one by name with `emotionFromName(name)` from `face-state`; it upper-cases its input and returns `undefined` for an unknown name (so guard it, as `apply()` does). |
| `setEyeOpen(key, value)` **(used)** | `key` is `'left'` or `'right'`. `value` in `[0, 1]` (0 closed, 1 open). Throws `Error('value must be between 0 and 1')` outside the range. |
| `setMouthOpen(value)` | `value` in `[0, 1]`, same throw. Note TTS drives this itself while speaking (`onPlayed` sets `min(power/2000, 1)`, `onDone` sets 0), so a manual value gets overwritten during speech. |
| `setColor(key, r, g, b)` | `key` is `'primary'` or `'secondary'` (face theme). Each channel is clamped to 0-255 and truncated to an integer; non-finite becomes 0. Defaults: primary white `#ffffff`, secondary black `#000000`. |

Gaze: eye `gazeX`/`gazeY` are computed automatically from `motion.lookAt` (see below). There is no direct gaze setter.

## `motion` (MotionCapability)

Neck servos (pan = yaw, tilt = pitch). On M5StackChan hardware the driver is `M5StackChanServoDriver`.

| Member | Behaviour |
| --- | --- |
| `pose` | Read-only live `{body: Pose, eyes: {left: Pose, right: Pose}}`. `body.rotation` is refreshed from the servos only while gaze polling runs (see `lookAt`); otherwise it can be stale. Eye positions default to `x 0.03`, `y ±0.009`, `z 0`. |
| `lookAt(position: Vector3)` | Sets a gaze target (body-frame metres) and returns immediately. Starts a 100 ms poll (`INTERVAL_POSE`). Each poll reads servo angles; if the target is more than 30° (`GAZE_THRESHOLD = π/6`) off in yaw or pitch, the controller turns torque on, moves to face the target over a random 0.5-1.0 s, then drops torque 50 ms after the move ends. Smaller offsets are left to the eyes (face `gazeX`/`gazeY`). Polling is paused while the context is paused. |
| `lookAway()` | Clears the gaze target; polling stops once no move is in flight. Eyes stop tracking. |
| `setPose(pose, time?)` **(used)** | Returns `Promise<void>` that resolves when the driver finishes the command, rejects with the driver error. Only `pose.rotation` is used (`position` ignored). `time` is seconds (`MotionDurationSeconds`); the M5StackChan driver defaults it to **0.5 s** when omitted, and `0` means move immediately (raw position write, no goal time). Marked `@experimental` in the source. Does **not** turn torque on; call `setTorque(true)` first or the servo will not move. |
| `setTorque(torque)` **(used)** | `Promise<void>`. Pan is set first, then tilt; a pan error short-circuits. `true` holds position, `false` lets the head go limp. |

M5StackChan servo conversion (`m5stackchan-servo.ts`):

- yaw angle (0.1° units) = `trunc(rotation.y * 1800/π)`, clamped to ±1280, i.e. **±128°**.
- pitch angle = `trunc(-rotation.p * 1800/π)`, clamped to 50..850, i.e. **5° to 85° up**. Neutral (`p = 0`) and any out-of-range request clamp to 5°. Pitch below the floor (looking down) is not reachable; "as low as it goes" is 5° up. This is why `mod.js` `FAILED_DOWN_RAD` works as "lowest".
- `rotation.r` is ignored (roll has no servo).

## `audio` (AudioCapability)

Every playback call first stops `media` and `webRadio`, and increments an "active operations" counter; while it is non-zero `media.start/resume/seek` and `webRadio.start` reject with `Error('audio busy')`.

| Member | Behaviour |
| --- | --- |
| `tone(hz, duration, volume?)` **(used)** | `Promise<void>`. `duration` in **milliseconds**. `volume` in `[0, 1]` else rejects `Error('Volume must be between 0 and 1')`; default is the speaker's volume (0.5). Plays a 24 kHz mono tone, resolves when finished. With no speaker it resolves immediately without sound. `mod.js` catches and traces rejection. |
| `say(text, volume?)` | `Promise<Maybe<string>>`. Streams `text` through the active TTS, resolves `{success:true, value:text}` when playback ends, or `{success:false, reason}`. Also on `conversation.say` and legacy `robot.say`. Animates the mouth. |
| `sing(koe, volume?)` | Same, but sends raw stackchan-voice koe notation to `tts.streamKoe`. Fails with reason `Error: The active TTS does not support singing.` if the provider has no `streamKoe`. Never falls back to plain TTS. |
| `useTTS(tts)` | Replaces the TTS engine; detaches the old one's `onPlayed`/`onDone` and binds the new one's to the mouth. `TTS = {stream(text, volume?, cb?), streamKoe?(koe, volume?, cb?), onPlayed?, onDone?}`. Do not set `onPlayed`/`onDone` yourself; the runtime owns them. |
| `tts` | The current `TTS` object (getter). |
| `microphone?` | `{record(ms?)}`, present only if the device has a mic. |
| `record(durationMs?)` | `Promise<OwnedAudioBuffer>`. Rejects `Error('This device does not support a microphone.')` when there is no mic. |
| `playAudio(buffer)` | `Promise<boolean>`: `true` when playback completes; `false` if no speaker, buffer unsupported/empty (WAV header is 44 bytes; <= 44 bytes is empty), or playback fails. Caller keeps ownership of the buffer. |
| `media?` | Finite or live MP3: `state` (`WebRadioState` plus `'ended' \| 'paused'`), `progress {position, duration?, estimated, seekable}`, `start({url, mode: 'live'\|'finite', volume?, duration?, onProgress?, reconnect?, onStateChanged?})`, `pause()`, `resume()`, `seek(sec)`, `stop()`, `setVolume(v)`. `reconnect` applies to live only. Undefined on targets without MP3 support. |
| `webRadio?` | Live MP3 only: `state`, `start({url, volume?, sampleRate?, reconnect?, onStateChanged?})`, `stop()`, `setVolume(v)`. States: `idle, connecting, buffering, playing, stalled, retrying, error`. When `media` exists, `webRadio` is a view onto it (`ended`/`paused` map to `idle`) and rejects any `sampleRate` other than 44100. |

## `lighting` (LightingCapability)

`led` is a name-to-strip map supplied by the platform (names differ per target, so iterate with `Object.keys(robot.lighting.led)` **(used)** instead of hardcoding). Each `RobotLed` has `on/off/blink/rainbow`. The four helper methods look up `led[ledName]`; an unknown name does nothing.

| Method | Parameters |
| --- | --- |
| `lightOn(name, r, g, b, duration?, index?, count?)` **(used)** | `r,g,b` 0-255. Optional `duration` ms: the LED turns itself off after that long (auto-off timer; omit to stay on). `index`/`count` select a sub-range of pixels. |
| `lightOff(name, index?, count?)` **(used)** | Turn off the whole strip or a range. `mod.js` calls it before every new mode. The LED drivers also cancel their own running effect when a new one starts, so this is belt and braces. |
| `lightBlink(name, r, g, b, duration, index?, count?)` **(used)** | `duration` is required: the full on+off cycle in ms (NeoPixel `Blink` effect: lit for the first half, dark for the second; default 1000 there). The PY32 LED driver uses half of it per phase with a 50 ms floor per phase. |
| `lightRainbow(name, index?, count?)` **(used)** | Rainbow effect. |

On `lifecycle.close()` every LED is turned off, errors swallowed per LED.

## `ui` (RuntimeUICapability)

`RuntimeUICapability = RobotUI & { controller, drawer, showBalloon, hideBalloon }`. The same `showBalloon`/`hideBalloon`/`drawer` are also on the context root (legacy flat).

### Balloon **(used)**

| Method | Behaviour |
| --- | --- |
| `showBalloon(text, option?)` | Shows one speech balloon. If a balloon is already showing with identical options (`left, right, top, bottom, width, height, tail`), only its text is updated in place. Otherwise the old one is removed and a new one is added. Default layout: `left 16, right 16, bottom 12, minHeight 44`, font `k8x12-12`. |
| `hideBalloon()` | Removes the balloon if present. No-op otherwise. |

`ShowBalloonOptions = {left?, right?, top?, bottom?, width?, height?, tail?: 'top-left' \| 'top-right' \| 'bottom-left' \| 'bottom-right'}`. When `tail` is omitted, bottom placement uses `top-left`, while an explicit `top` position uses `bottom-left` (from `docs/api.md`).

### Face and layout

| Member | Behaviour |
| --- | --- |
| `update(interval, faceState)` | Push a `FaceState` to the renderer. The runtime already calls this at 30 Hz; MODs normally should not. |
| `setFace(face: PiuContainer)` | Replace the face component. |
| `setFaceMotionEnabled?(enabled)` | Turn periodic idle face motions on or off without swapping the face. Optional. |
| `setHandAnimation(name)` | One of `'none' \| 'rock-paper-scissors' \| 'clap' \| 'thinking'`. |
| `setMain(content)` / `showFace()` | Swap the main area for a full-area dialog (AppBar and Drawer stay active) / restore the face. |
| `addEffect(effect, key?)` / `removeEffect(effect)` | Add or remove a Piu overlay (`UIEffect = Piu Content`). |
| `application?` | Raw Piu application (`unknown`). Escape hatch. |
| `controller` | The underlying `RobotUI`. |
| `miniApps` | `{register(def): () => void}`. `def = {id, title, icon?: 'play', create(ctx)}` where `ctx = {width, height, close()}` and `create` returns a Piu container or `{content, dispose?}`. `id`: 1-64 chars, lowercase ASCII/digits separated by `.`, `_`, `-`. `title`: 1-32 chars after trim. Duplicate id throws. Returns an unregister function. Experimental. |

### Drawer

Slide-in side panel (160 px wide).

`robot.ui.drawer` / `robot.drawer` (`DrawerCapability`):

| Method | Behaviour |
| --- | --- |
| `addDrawerButton(spec)` | `DrawerButtonSpec = {key, label, callback(context, value?), kind?: 'action'\|'choice'\|'swatch'\|'toggle', initialState?, value?, options?: {value,label,color?}[], icon?: IconName}`. `callback` receives the context and the chosen value; sync throws and promise rejections are caught and traced (`[DrawerButton] ...`), never propagated. `initialState` (if given) sets the toggle state right away. |
| `removeDrawerButton(key)` | Unbinds and removes. |
| `clearDrawerButtons()` | Removes all. |
| `setDrawerButtonState(key, active)` | Set toggle/active state. |

`IconName`: `apps, back, camera, check, close, clock, language, menu, microphone, offline, palette, play, retry, scan, settings, volume, wifi`.

Low-level `RobotUI` drawer methods (`setDrawerButtons`, `addDrawerButton` with a view spec, `removeDrawerButton`, `setDrawerButtonState`, `bindDrawerAction(key, cb): boolean`, `unbindDrawerAction`, `openDrawer`, `closeDrawer`, `toggleDrawer`) are on `robot.ui`. Prefer `drawer.*` for buttons, and `ui.openDrawer/closeDrawer/toggleDrawer` to control visibility.

## `input` (InputCapability)

All members optional; check for `undefined`.

| Member | Behaviour |
| --- | --- |
| `button?` | `Partial<Record<'a'\|'b'\|'c'\|'power', {onEvent?}>>`. Assign `robot.input.button.a.onEvent = (e) => ...`. Event: `{kind: 'button', name, pressed: boolean, ticks}`, fired on both press and release (`pressed` tells which). The whole `button` object is `undefined` if the platform has no buttons; individual keys are missing for absent buttons. |
| `touch?` | Screen touch. `onEvent(e)` with `{kind: 'touch', phase: 'began'\|'moved'\|'ended', id, x, y, ticks}`. Present only when the platform has `config.Touch`. Has `close()`. |
| `touchPanel?` | Top touch strip. `onEvent(e)` with `{kind: 'touch-panel', gesture: 'press'\|'release'\|'forwardSwipe'\|'backwardSwipe', position, intensity, ticks, tap?: {durationMs, maxMovement, position}}`; `subscribe(listener)` returns an unsubscribe fn; `sample` is the latest readings. The runtime calls `start()` for you. The camera pauses it while capturing. |
| `imu?` | `onEvent(e)` with `{kind: 'imu', motion: 'shake'\|'fallenForward'\|'fallenBackward'\|'fallenLeft'\|'fallenRight'\|'upsideDown', ticks}`. Polls every 100 ms once `start()` is called. `StackchanRuntimeInput` does not start it (the stock default behaviour calls `robot.imu.start()` itself), so a MOD must call `robot.input.imu.start()` and `stop()` to end. |

## `camera` (RobotCamera)

Also on the context root as `robot.camera`. Always defined: a null camera is substituted when the device has none (`available: false`, `capture()` resolves `undefined`).

| Member | Behaviour |
| --- | --- |
| `available?` | `false` when absent. |
| `start(options?)` / `stop()` | Begin or end a capture session. May return a promise. While a camera session is active the touch panel is paused, and is resumed on stop or failure. |
| `capture(options?)` | `Promise<CameraFrame \| undefined>`. `CameraCaptureOptions = {width?, height?, imageType?: 'rgb565le'\|'rgb565be'\|'yuv422'\|'jpeg'}`. `CameraFrame = {width, height, imageType, buffer: ArrayBuffer, close?()}`. If no session is active, it pauses the touch panel for the duration of the call. Call `frame.close?.()` when done. |
| `close?()` | Stops and releases the camera (done by `lifecycle.close()`). |

## `conversation` (ConversationCapability)

| Member | Behaviour |
| --- | --- |
| `say(text, volume?)` | Same as `audio.say`. |
| `remoteSession?` | Present only when the host has a remote conversation session. `state`: `'standby' \| 'connecting' \| 'listening' \| 'recognizing' \| 'speaking' \| 'blocked'`; `transportState`: `'disconnected' \| 'unsupported' \| 'ready'`; `activationState`: `'inactive' \| 'active'`; `lastError?`; `requestStart(): string`, `requestStop(): string`, `subscribe(listener): unsubscribe`, `subscribeTransport(listener): unsubscribe`, `activate()`, `deactivate()`. |

## `connectivity` (ConnectivityCapability)

| Member | Behaviour |
| --- | --- |
| `network?.ready` | `Promise<NetworkReadyResult>` that settles after the boot Wi-Fi attempt: `{status: 'connected'}`, `{status: 'skipped', reason}` (no credentials), or `{status: 'failed', reason}`. It does not reject. `mod.js` does **not** wait on it before `new WebSocket(...)`; it relies on its own retry loop instead. |
| `localPeer?` | Nearby messaging (ESP-NOW or BLE Serial). `id` (own id); `open({service, transport?: 'espnow'\|'ble', displayName?, sharedKey?})` returns a `LocalPeerSession`. Session: `discover({timeoutMs?})`, `send(peerId, type, payload)`, `broadcast(type, payload)`, `subscribe(type or '*', handler)` returns an unsubscribe fn, `close()`. Payload is `JsonValue`. Errors are `LocalPeerError` with `code` in `not-supported, invalid-argument, peer-unavailable, message-too-large, timeout, closed, transport`. Limits: service and type 64 UTF-8 bytes, display name 32 bytes, message 2 KiB. One session at a time. Opening after `lifecycle.close()` rejects with code `closed`. Sessions you open are closed by `lifecycle.close()`. See `vendor/stack-chan/firmware/docs/local-peer-communication.md`. |

## `i18n` (I18nCapability)

Frozen, host-owned.

| Member | Behaviour |
| --- | --- |
| `locale` | `'ja' \| 'en' \| 'zh-CN'` (default `ja`). Getter, reflects the live host locale. |
| `localize(key, values?)` | Looks up `key` in the MOD catalog (`modLocals`) first, then the host catalog; returns the key itself if neither has it. `{name}` placeholders are replaced from `values` (string or number); unknown placeholders are left as-is. |

## `lifecycle` (LifecycleCapability)

| Member | Behaviour |
| --- | --- |
| `close()` | `Promise<void>`, idempotent. Stops the 30 Hz face timer and the motion poll and its release-torque timer, closes host-owned resources, closes open `localPeer` sessions, stops/closes the camera, then closes input (touch, touch panel, IMU), audio (stops media/webRadio and the mic, detaches TTS callbacks) and lighting (all LEDs off). Rejects with the **first** error, after attempting every step. Network is not closed (owned by boot services). |

---

## Not part of `StackchanContext` but used by `mod.js`

- `trace(string)`: global debug log (shows in `bun run device:logs`).
- `Timer` (`import Timer from "timer"`): `set(fn, ms)`, `clear(handle)`, `repeat(fn, ms)`. Note: this MOD's `Timer.set` handles are **not** cleaned up by `lifecycle.close()`.
- `WebSocket` (`import WebSocket from "WebSocket"`), `emotionFromName` (`import {emotionFromName} from "face-state"`).

## Gotchas seen in `mod.js`

1. `setPose` does not enable torque; `settleTilt` calls `setTorque(true)` first, and releases torque after a failed-state move so the servo does not push against its stop.
2. Pitch is clamped to 5-85° up on the M5StackChan driver; there is no looking down.
3. `setEyeOpen` throws outside `[0, 1]`; `emotionFromName` may return `undefined`.
4. `lightBlink` needs the `duration` argument (full cycle). `lightOn`'s optional `duration` is an auto-off timer, not an animation.
5. `mod.js` calls `lightOff` before each new mode; drivers cancel prior effects anyway, but it keeps behaviour explicit across LED drivers.
6. `audio.tone` stops any media playback and rejects on a bad volume; the MOD catches it.
7. `robot.pose` / `motion.pose` is only fresh while a `lookAt` poll is running.
