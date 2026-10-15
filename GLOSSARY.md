# Command Center

A local daemon that manages Claude Code sessions across projects and exposes an API to desktop and device clients.

## Language

**Daemon**:
The long-running Bun process that is the command center. It owns config, sessions and the API.
_Avoid_: server, backend, CLI

**Desktop app**:
The Tauri dashboard and tray for the daemon. It never owns the daemon and never writes config directly.
_Avoid_: UI, frontend

**Device**:
An external client (first: stack-chan) that connects to the daemon over HTTP and WebSocket.
_Avoid_: client, robot

**Config dir**:
The directory (`~/.config/das`, override `DAS_CONFIG_DIR`) holding the config file, pid file, daemon log and the logs directory.
_Avoid_: settings dir, app support dir

**Config file**:
`config.yml` in the config dir. Effective config is env over file over code defaults. The daemon is its only writer.
_Avoid_: settings file, config.json

**Reload**:
Re-reading the config file in the running daemon via `daemon --reload`. A bad file keeps the previous config; a port change needs a restart.

**WS log**:
`ws.log` in the logs directory: WebSocket lifecycle and frame types, no payloads.

**API log**:
`api.log` in the logs directory: one entry per HTTP request, including hook traffic.
_Avoid_: access log

**Daemon log**:
`daemon.log`: raw stdout/stderr of the background daemon, separate from the WS log and API log.

**Log stream**:
Live feed of WS log and API log entries from the daemon to the desktop app, merged into one timeline. Opening it first replays recent entries held since the daemon started. The Daemon log is not part of it.
_Avoid_: tail, log tail

**Debug tab**:
The desktop app view that shows the Log stream, with pause, clear, and filters by source and text.

**Display**:
What the robot shows for the whole fleet of sessions: an expression, a headline, a count and a light. Derived from the highest-priority session state.

**Light**:
The LED effect part of a Display: rainbow, solid colour, or blink. Server decides the colour; the robot only renders it.

**Link state**:
Whether the robot's connection to the daemon is connecting, failed, or connected. Known only to the robot, so the robot itself shows it: while not connected it overrides the Display (and any stale Display is dropped). Failed begins after three consecutive failed attempts and lasts until the connection opens.
_Avoid_: connection status, network state

**Session state**:
One of running, waiting, done, error, idle. Priority when mixed: error > waiting > running > done > idle.
