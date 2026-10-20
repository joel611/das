// Pure helpers for build.mjs, split out so they can be unit-tested without running a build.

// The .xsa is named after the manifest's directory, so staging and output paths must agree on this.
export const MOD_NAME = "stackchan-mod";

export function xsaPath(firmware) {
  return `${firmware}/dist/bin/esp32/release/${MOD_NAME}/${MOD_NAME}.xsa`;
}

// Strip every --server-url (the package.json script sets a default); the last one wins.
// --install is consumed here, everything else is passed through to the firmware build.
export function parseArgs(args) {
  let url;
  const rest = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === "--server-url") url = args[++j];
    else if (a.startsWith("--server-url=")) url = a.slice("--server-url=".length);
    else if (a !== "--install") rest.push(a);
  }
  return { url, install: args.includes("--install"), rest };
}

// Daemon WebSocket URL for DAEMON_HOST, which carries its scheme: ws://host:port (no TLS) or
// wss://host (TLS, e.g. the Tailscale Funnel on 443).
export function serverUrlFromHost(host) {
  if (!host) return undefined;
  if (!/^wss?:\/\/[^/]+\/?$/.test(host)) {
    throw new Error(`DAEMON_HOST must look like ws://host:port or wss://host, got "${host}"`);
  }
  return `${host.replace(/\/$/, "")}/v1/ws`;
}
