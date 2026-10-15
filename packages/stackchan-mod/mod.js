import WebSocket from "WebSocket";
import { emotionFromName } from "face-state";
import Timer from "timer";

// Edit this to point at the stack-chan-server (use the LAN IP on a real device).
const SERVER_URL = "ws://localhost:5777/v1/ws";
const RETRY_MS = 3000;
// An attempt with no open/error/close by then counts as failed.
const CONNECT_TIMEOUT_MS = 10000;
// Consecutive failed attempts before the Link state becomes "failed".
const FAIL_AFTER = 3;
// Head tilt (pan stays centred). Pose pitch is positive when looking down, so
// "up" is negated when sent. The servo driver clamps to its safe range
// (M5StackChan: 5-85 degrees up), so FAILED_DOWN_RAD just means "as low as it goes".
const IDLE_TILT_UP_RAD = (10 * Math.PI) / 180;
const FAILED_DOWN_RAD = 0.5;

// Per Link state: what the robot shows. Failed uses closed eyes + HAPPY as the
// closest built-in to X X eyes and a ^ mouth.
const LINKS = {
  connecting: {
    tiltUp: IDLE_TILT_UP_RAD,
    light: { mode: "blink", rgb: [0, 0, 255], periodMs: 500 },
    emotion: "NEUTRAL",
    eyes: 1,
  },
  failed: {
    tiltUp: -FAILED_DOWN_RAD,
    releaseTorque: true,
    light: { mode: "solid", rgb: [255, 0, 0] },
    emotion: "HAPPY",
    eyes: 0,
  },
  connected: { tiltUp: IDLE_TILT_UP_RAD, eyes: 1 },
};

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

  // Move to a fixed tilt (positive = up). Torque stays on to hold the pose;
  // with releaseTorque it is dropped after the move so the servo does not
  // push against its stop.
  function settleTilt(up, releaseTorque) {
    robot.motion
      .setTorque(true)
      .then(() => robot.motion.setPose({ rotation: { y: 0, p: -up, r: 0 } }, 0.8))
      .then(() => {
        if (releaseTorque) Timer.set(() => robot.motion.setTorque(false).catch(() => { }), 1000);
      })
      .catch((e) => trace(`tilt failed: ${e}\n`));
  }

  // Link state overrides the Display until connected. Stale Display is dropped.
  // Connected has no light/emotion: the server Display supplies them.
  function setLink(next) {
    if (next === link) return;
    link = next;
    const s = LINKS[next];
    if (next !== "connected") {
      lastHeadline = undefined;
      robot.hideBalloon();
    }
    if (s.light) setLight(s.light);
    if (s.emotion) robot.face.setEmotion(emotionFromName(s.emotion));
    robot.face.setEyeOpen("left", s.eyes);
    robot.face.setEyeOpen("right", s.eyes);
    settleTilt(s.tiltUp, s.releaseTorque);
  }

  function scheduleRetry() {
    if (retry === undefined) retry = Timer.set(connect, RETRY_MS);
  }

  function attemptFailed() {
    failures += 1;
    if (failures >= FAIL_AFTER) setLink("failed");
    scheduleRetry();
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
    // pending -> open -> dead. Events on a dead socket are no-ops.
    let phase = "pending";
    const timeout = Timer.set(() => {
      trace("ws connect timeout\n");
      end();
    }, CONNECT_TIMEOUT_MS);
    function end() {
      if (phase === "dead") return;
      const wasOpen = phase === "open";
      phase = "dead";
      Timer.clear(timeout);
      try {
        ws.close();
      } catch (e) { }
      if (wasOpen) {
        failures = 0;
        setLink("connecting");
        scheduleRetry();
      } else {
        attemptFailed();
      }
    }
    ws.addEventListener("open", () => {
      trace("ws open\n");
      if (phase !== "pending") return;
      phase = "open";
      Timer.clear(timeout);
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
    ws.addEventListener("error", () => {
      trace("ws error\n");
      end();
    });
    ws.addEventListener("close", () => {
      trace("ws closed\n");
      end();
    });
  }

  setLink("connecting");
  connect();
}

export default {
  onContextCreated,
};
