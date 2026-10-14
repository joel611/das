import WebSocket from "WebSocket";
import { emotionFromName } from "face-state";
import Timer from "timer";

// Edit this to point at the stack-chan-server (use the LAN IP on a real device).
const SERVER_URL = "ws://localhost:5777/v1/ws";
const RETRY_MS = 3000;
// Consecutive failed attempts before the Link state becomes "failed".
const FAIL_AFTER = 3;
// Head sweep while connecting: +-PAN_RAD, one full left-right-left cycle.
const PAN_RAD = 0.35;
const PAN_HALF_CYCLE_MS = 5000;
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
  let sweep;
  let panSign = 1;

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

  function pan(y, seconds) {
    robot.motion.setPose({ rotation: { y, p: 0, r: 0 } }, seconds);
  }

  function stopSweep() {
    if (sweep === undefined) return;
    Timer.clear(sweep);
    sweep = undefined;
    pan(0, 0.5);
  }

  function startSweep() {
    if (sweep !== undefined) return;
    const step = () => {
      pan(PAN_RAD * panSign, PAN_HALF_CYCLE_MS / 1000);
      panSign = -panSign;
    };
    step();
    sweep = Timer.repeat(step, PAN_HALF_CYCLE_MS);
  }

  // Link state overrides the Display until connected. Stale Display is dropped.
  function setLink(next) {
    if (next === link) return;
    link = next;
    if (link === "connected") {
      stopSweep();
      robot.face.setEyeOpen("left", 1);
      robot.face.setEyeOpen("right", 1);
      return;
    }
    lastHeadline = undefined;
    robot.hideBalloon();
    if (link === "connecting") {
      setLight(CONNECTING_LIGHT);
      robot.face.setEmotion(emotionFromName("NEUTRAL"));
      startSweep();
    } else {
      stopSweep();
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
    let ws;
    try {
      ws = new WebSocket(SERVER_URL);
    } catch (e) {
      trace(`ws create failed: ${e}\n`);
      attemptFailed();
      return;
    }
    let opened = false;
    ws.addEventListener("open", () => {
      trace("ws open\n");
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
    ws.addEventListener("error", () => trace("ws error\n"));
    ws.addEventListener("close", () => {
      trace("ws closed\n");
      if (opened) {
        failures = 0;
        setLink("connecting");
        if (retry === undefined) retry = Timer.set(connect, RETRY_MS);
      } else attemptFailed();
    });
  }

  setLink("connecting");
  connect();
}

export default {
  onContextCreated,
};
