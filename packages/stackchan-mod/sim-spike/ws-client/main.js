// Spike: can a Moddable desktop-simulator app talk to stack-chan-server over WebSocket?
import { Client } from "websocket";

const ws = new Client({ host: "127.0.0.1", port: 4322, path: "/v1/ws" });

ws.callback = function (message, value) {
  switch (message) {
    case Client.connect:
      trace("socket connect\n");
      break;

    case Client.handshake:
      trace("websocket handshake success\n");
      this.write(
        JSON.stringify({ type: "hello", device: "moddable-sim", capabilities: ["screen"] }),
      );
      break;

    case Client.receive: {
      const frame = JSON.parse(value);
      trace(`frame ${frame.type}: ${JSON.stringify(frame.display)}\n`);
      break;
    }

    case Client.disconnect:
      trace("websocket close\n");
      break;
  }
};
