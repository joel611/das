import WebSocket from "WebSocket";
import { emotionFromName } from "face-state";
import Timer from "timer";

// Edit this to point at the stack-chan-server (use the LAN IP on a real device).
const SERVER_URL = "ws://localhost:5777/v1/ws";
const RETRY_MS = 3000;
// An attempt with no open/error/close by then counts as failed.
const CONNECT_TIMEOUT_MS = 15000;
// Consecutive failed attempts before the Link state becomes "failed".
const FAIL_AFTER = 3;
// Head tilt (pan stays centred). Pose pitch is positive when looking down, so
// "up" is negated when sent. The servo driver clamps to its safe range
// (M5StackChan: 5-85 degrees up), so FAILED_DOWN_RAD just means "as low as it goes".
const IDLE_TILT_UP_RAD = (10 * Math.PI) / 180;
const FAILED_DOWN_RAD = 0.5;
const CONNECTING_LIGHT = { mode: "blink", rgb: [0, 0, 255], periodMs: 500 };
const FAILED_LIGHT = { mode: "solid", rgb: [255, 0, 0] };

// server expression -> stack-chan face emotion name (see face-state.ts)
const EMOTIONS = {
  neutral: "NEUTRAL",
  focused: "ANGRY", // narrowed eyes
  worried: "DOUBTFUL",
  happy: "HAPPY",
  sad: "SAD",
};

// Type hints for the editor only; Moddable ignores these comments.
// Import StackchanContext by relative path: the bare 'capabilities' name is
// shadowed by ambient stubs and loses the robot types.
// Paths assume this mod lives at packages/stackchan-mod/ (two levels below the repo root).
/** @typedef {import('../../vendor/stack-chan/firmware/host/app/capabilities').StackchanContext} StackchanContext */
/** @typedef {import('../../vendor/stack-chan/firmware/host/app/app-behavior').StackchanAppBehaviorOption} Option */
/** @typedef {import('stackchan-util').Pose} Pose */
/** @typedef {import('face-state').Emotion} Emotion */

/**
 * @param {StackchanContext} robot
 * @param {Option} _option rename to `option` once used
 */
function onContextCreated(robot, _option) {
  let lastHeadline;
  let lastLight;
  let retry;
  let link; // connecting | failed | connected
  let failures = 0;

  // Render a server-sent light spec on every LED. Absent spec = off.
  function setLight(light) {
    const key = JSON.stringify(light ?? null);
    if (key === lastLight) return;
    lastLight = key;
    const lighting = robot.lighting;
    for (const name of Object.keys(lighting.led)) {
      lighting.lightOff(name);
      if (light?.mode === "rainbow") lighting.lightRainbow(name);
      else if (light?.mode === "solid") lighting.lightOn(name, ...light.rgb);
      else if (light?.mode === "blink") lighting.lightBlink(name, ...light.rgb, light.periodMs);
    }
  }

  // Move to a fixed tilt (negative = down). Torque stays on to hold an upward
  // pose; when resting at the bottom it is released after the move so the
  // servo does not push against its stop.
  function settleTilt(up) {
    robot.motion
      .setTorque(true)
      .then(() => robot.motion.setPose({ rotation: { y: 0, p: -up, r: 0 } }, 0.8))
      .then(() => {
        if (up < 0) Timer.set(() => robot.motion.setTorque(false).catch(() => { }), 1000);
      })
      .catch((e) => trace(`tilt failed: ${e}\n`));
  }

  // Link state overrides the Display until connected. Stale Display is dropped.
  function setLink(next) {
    if (next === link) return;
    link = next;
    if (link === "connected") {
      settleTilt(IDLE_TILT_UP_RAD);
      robot.face.setEyeOpen("left", 1);
      robot.face.setEyeOpen("right", 1);
      return;
    }
    lastHeadline = undefined;
    robot.hideBalloon();
    if (link === "connecting") {
      settleTilt(IDLE_TILT_UP_RAD);
      setLight(CONNECTING_LIGHT);
      robot.face.setEmotion(emotionFromName("NEUTRAL"));
    } else {
      settleTilt(-FAILED_DOWN_RAD);
      setLight(FAILED_LIGHT);
      // Closest built-in to X X eyes and ^ mouth: closed eyes, happy.
      robot.face.setEmotion(emotionFromName("HAPPY"));
      robot.face.setEyeOpen("left", 0);
      robot.face.setEyeOpen("right", 0);
    }
  }

  function attemptFailed() {
    failures += 1;
    if (failures >= FAIL_AFTER) setLink("failed");
    if (retry === undefined) retry = Timer.set(connect, RETRY_MS);
  }

  function apply(display) {
    if (link !== "connected" || display == null) return;
    setLight(display.light);
    const emotion = emotionFromName(EMOTIONS[display.expression] ?? "NEUTRAL");
    if (emotion !== undefined) robot.face.setEmotion(emotion);
    if (display.headline !== lastHeadline) {
      lastHeadline = display.headline;
      if (display.headline) robot.showBalloon(display.headline);
      else robot.hideBalloon();
    }
  }

  function connect() {
    retry = undefined;
    trace(`ws connect attempt, failures=${failures}\n`);
    let ws;
    try {
      ws = new WebSocket(SERVER_URL);
    } catch (e) {
      trace(`ws create failed: ${e}\n`);
      attemptFailed();
      return;
    }
    let opened = false;
    let settled = false; // this attempt already counted as failed
    const timeout = Timer.set(() => {
      trace("ws connect timeout\n");
      fail();
    }, CONNECT_TIMEOUT_MS);
    function fail() {
      if (opened || settled) return;
      settled = true;
      Timer.clear(timeout);
      try {
        ws.close();
      } catch (e) { }
      attemptFailed();
    }
    ws.addEventListener("open", () => {
      trace("ws open\n");
      Timer.clear(timeout);
      if (settled) {
        // Attempt already counted failed (timeout); drop the late socket, next retry reconnects.
        try {
          ws.close();
        } catch (e) { }
        return;
      }
      opened = true;
      failures = 0;
      setLink("connected");
      ws.send(
        JSON.stringify({
          type: "hello",
          device: "stack-chan",
          capabilities: ["screen", "speaker", "buttons"],
        }),
      );
    });
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "snapshot" || msg.type === "delta") apply(msg.display);
      } catch (e) {
        trace(`ws bad message: ${e}\n`);
      }
    });
    // Open socket lost (close, or error with no close after it): back to connecting.
    function lost() {
      opened = false;
      settled = true; // a later close/error on this socket must not count as a new failure
      try {
        ws.close();
      } catch (e) { }
      failures = 0;
      setLink("connecting");
      if (retry === undefined) retry = Timer.set(connect, RETRY_MS);
    }
    ws.addEventListener("error", () => {
      trace("ws error\n");
      if (opened) lost();
      else fail();
    });

    ws.addEventListener("close", () => {
      trace("ws closed\n");
      if (opened) lost();
      else fail();
    });
  }

  setLink("connecting");
  connect();
}

export default {
  onContextCreated,
};
