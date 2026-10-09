import { invoke } from "@tauri-apps/api/core"

import type { DaemonState, Device, HookStatus, Project, Session, Settings, SettingsPatch, VoiceReply } from "./types"

// Inside the Tauri window the Rust `api` command relays the call (and adds the token).
// In a plain browser (vite dev) the same paths go through the `/daemon` dev proxy.
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let status: number
  let data: unknown
  if (inTauri) {
    const r = await invoke<{ status: number; body: unknown }>("api", {
      method,
      path,
      body: body === undefined ? null : JSON.stringify(body),
    })
    status = r.status
    data = r.body
  } else {
    const res = await fetch(`/daemon${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    status = res.status
    data = await res.json().catch(() => null)
  }
  if (status >= 400) {
    const msg = (data as { error?: string } | null)?.error
    throw new ApiError(msg ?? `${method} ${path}: ${status}`, status)
  }
  return data as T
}

export const api = {
  state: () => call<DaemonState>("GET", "/v1/state"),
  sessions: () => call<Session[]>("GET", "/v1/sessions"),
  projects: () => call<Project[]>("GET", "/v1/projects"),
  devices: () => call<Device[]>("GET", "/v1/devices"),
  settings: () => call<Settings>("GET", "/admin/settings"),
  saveSettings: (patch: SettingsPatch) => call<Settings>("PUT", "/admin/settings", patch),
  hooks: () => call<HookStatus>("GET", "/admin/hooks"),
  installHooks: () => call<HookStatus>("POST", "/admin/hooks/install"),
  uninstallHooks: () => call<HookStatus>("DELETE", "/admin/hooks"),
  voice: (text: string, device: string, dryRun: boolean) =>
    call<VoiceReply>("POST", "/v1/voice", { text, device, dryRun, debug: dryRun }),
}
