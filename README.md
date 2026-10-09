# stack-chan-server

Run: `PROJECT_ROOTS=~/Projects bun src/server.ts` (env: `PORT`, `TOKEN`). Test: `bun test`.

## WebSocket protocol

`WS /v1/ws` (JSON text frames). Auth: `Authorization: Bearer <TOKEN>` or `?token=<TOKEN>` (only when `TOKEN` is set).

| Direction | Frame |
|---|---|
| client -> server | `{"type":"hello","device":"name","capabilities":["display"]}` |
| server -> client | `{"type":"snapshot","projects":[...],"sessions":[...],"display":D}` (reply to hello) |
| server -> client | `{"type":"delta","session":{...},"display":D}` (session changed) |
| server -> client | `{"type":"delta","removed":"<sessionId>","display":D}` (SessionEnd) |

`D = {"expression":"focused|worried|happy|sad|neutral","headline":"3 running","count":3}`.
Rollup priority: error > waiting > running > done > idle. `voice.transcript` and `button` are reserved (ignored); unknown messages are ignored.

## Try it

```sh
bun scripts/mock-client.ts ws://localhost:4321/v1/ws
curl -X POST localhost:4321/hooks/UserPromptSubmit -d '{"session_id":"s1","cwd":"/tmp"}'
curl -X POST localhost:4321/hooks/Stop -d '{"session_id":"s1"}'
curl -X POST localhost:4321/hooks/SessionEnd -d '{"session_id":"s1"}'
```
