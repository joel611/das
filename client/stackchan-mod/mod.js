import WebSocket from 'WebSocket'
import { emotionFromName } from 'face-state'
import Timer from 'timer'

// Edit this to point at the stack-chan-server (use the LAN IP on a real device).
const SERVER_URL = 'ws://localhost:4321/v1/ws'
const RETRY_MS = 3000

// server expression -> stack-chan face emotion name (see face-state.ts)
const EMOTIONS = {
  neutral: 'NEUTRAL',
  focused: 'ANGRY', // narrowed eyes
  worried: 'DOUBTFUL',
  happy: 'HAPPY',
  sad: 'SAD',
}

function onContextCreated(robot) {
  let lastHeadline
  let retry

  function apply(display) {
    if (display == null) return
    const emotion = emotionFromName(EMOTIONS[display.expression] ?? 'NEUTRAL')
    if (emotion !== undefined) robot.face.setEmotion(emotion)
    if (display.headline !== lastHeadline) {
      lastHeadline = display.headline
      if (display.headline) robot.showBalloon(display.headline)
      else robot.hideBalloon()
    }
  }

  function connect() {
    retry = undefined
    let ws
    try {
      ws = new WebSocket(SERVER_URL)
    } catch (e) {
      trace(`ws create failed: ${e}\n`)
      retry = Timer.set(connect, RETRY_MS)
      return
    }
    ws.addEventListener('open', () => {
      trace('ws open\n')
      ws.send(JSON.stringify({ type: 'hello', device: 'stack-chan', capabilities: ['screen', 'speaker', 'buttons'] }))
    })
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'snapshot' || msg.type === 'delta') apply(msg.display)
      } catch (e) {
        trace(`ws bad message: ${e}\n`)
      }
    })
    ws.addEventListener('error', () => trace('ws error\n'))
    ws.addEventListener('close', () => {
      trace('ws closed\n')
      if (retry === undefined) retry = Timer.set(connect, RETRY_MS)
    })
  }

  connect()
}

export default {
  onContextCreated,
}
