import WebSocket from "WebSocket";
import { emotionFromName } from "face-state";
import Timer from "timer";

// Edit this to point at the stack-chan-server (use the LAN IP on a real device).
const SERVER_URL = "ws://localhost:5777/v1/ws";
const RETRY_MS = 3000;

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

  function apply(display) {
    if (display == null) return;
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
      retry = Timer.set(connect, RETRY_MS);
      return;
    }
    ws.addEventListener("open", () => {
      trace("ws open\n");
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
      if (retry === undefined) retry = Timer.set(connect, RETRY_MS);
    });
  }

  connect();
}

export default {
  onContextCreated,
};
