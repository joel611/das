import WebSocket from "WebSocket";
import { emotionFromName } from "face-state";
import Timer from "timer";

// Edit this to point at the stack-chan-server (use the LAN IP on a real device).
const SERVER_URL = "ws://localhost:5777/v1/ws";
const RETRY_MS = 3000;
// An attempt with no open/error/close by then counts as failed.
const CONNECT_TIMEOUT_MS = 5000;
// Consecutive failed attempts before the Link state becomes "failed".
const FAIL_AFTER = 3;
// Head tilt. Pan stays centred. Connecting nods between 0 and TILT_UP_RAD,
// one full cycle per SWEEP_PERIOD_MS, sent as small steps so the servo moves
// smoothly. Failed rests at 0; connected (idle) holds TILT_UP_RAD.
// Pose pitch is positive when looking down, so "up" is negated when sent.
const TILT_UP_RAD = (20 * Math.PI) / 180;
const SWEEP_PERIOD_MS = 10000;
const SWEEP_STEP_MS = 200;
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

  function tilt(up, seconds) {
    robot.motion.setPose({ rotation: { y: 0, p: -up, r: 0 } }, seconds).catch((e) => trace(`tilt failed: ${e}\n`));
  }

  function stopSweep() {
    if (sweep === undefined) return;
    Timer.clear(sweep);
    sweep = undefined;
  }

  // Move to a fixed tilt and stay there. Torque stays on unless resting at 0,
  // where it is released after the move like the stock motion controller.
  function settleTilt(up) {
    stopSweep();
    robot.motion
      .setTorque(true)
      .then(() => {
        tilt(up, 0.5);
        if (up === 0) Timer.set(() => robot.motion.setTorque(false).catch(() => {}), 600);
      })
      .catch((e) => trace(`torque failed: ${e}\n`));
  }

  function startSweep() {
    if (sweep !== undefined) return;
    const t0 = Date.now();
    robot.motion
      .setTorque(true)
      .then(() => {
        if (link !== "connecting" || sweep !== undefined) return;
        sweep = Timer.repeat(() => {
          const phase = ((Date.now() - t0) / SWEEP_PERIOD_MS) * 2 * Math.PI;
          tilt((TILT_UP_RAD * (1 - Math.cos(phase))) / 2, (SWEEP_STEP_MS * 1.5) / 1000);
        }, SWEEP_STEP_MS);
      })
      .catch((e) => trace(`torque failed: ${e}\n`));
  }

  // Link state overrides the Display until connected. Stale Display is dropped.
  function setLink(next) {
    if (next === link) return;
    link = next;
    if (link === "connected") {
      settleTilt(TILT_UP_RAD);
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
      settleTilt(0);
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
      } catch (e) {}
      attemptFailed();
    }
    ws.addEventListener("open", () => {
      trace("ws open\n");
      Timer.clear(timeout);
      if (settled) {
        // Attempt already counted failed (timeout); drop the late socket, next retry reconnects.
        try {
          ws.close();
        } catch (e) {}
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
    ws.addEventListener("error", () => {
      trace("ws error\n");
      fail();
    });
    ws.addEventListener("close", () => {
      trace("ws closed\n");
      if (opened) {
        opened = false;
        failures = 0;
        setLink("connecting");
        if (retry === undefined) retry = Timer.set(connect, RETRY_MS);
      } else fail();
    });
  }

  setLink("connecting");
  connect();
}

export default {
  onContextCreated,
};
