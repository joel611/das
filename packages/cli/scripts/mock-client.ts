// Usage: bun scripts/mock-client.ts [url]   (default ws://localhost:$PORT/v1/ws, add ?token=... if needed)
const url = process.argv[2] ?? `ws://localhost:${process.env.PORT || 4321}/v1/ws`;
const ws = new WebSocket(url);

ws.onopen = () => {
  console.log("connected", url);
  ws.send(JSON.stringify({ type: "hello", device: "mock-client", capabilities: ["display"] }));
};
ws.onmessage = (e) => console.log(JSON.stringify(JSON.parse(String(e.data)), null, 2));
ws.onclose = () => (console.log("closed"), process.exit(0));
ws.onerror = () => (console.error("connection error"), process.exit(1));
