import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { api } from "./api";
import type { CameraFrame, DeviceSignal, SettingsPatch } from "./types";

// Every daemon read polls; `ms` is the refetch interval.
export const useDaemonState = (ms = 2000) =>
  useQuery({ queryKey: ["state"], queryFn: api.state, refetchInterval: ms });
export const useSessions = (ms = 2000) =>
  useQuery({ queryKey: ["sessions"], queryFn: api.sessions, refetchInterval: ms });
export const useProjects = (ms = 10_000) =>
  useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: ms });
export const useUsage = (ms = 10_000) =>
  useQuery({ queryKey: ["usage"], queryFn: api.usage, refetchInterval: ms });
export const useDevices = (ms = 3000) =>
  useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: ms });
export const useSettings = (ms = 10_000) =>
  useQuery({ queryKey: ["settings"], queryFn: api.settings, refetchInterval: ms });
export const useHooks = (ms = 5000) =>
  useQuery({ queryKey: ["hooks"], queryFn: api.hooks, refetchInterval: ms });

export const useOmp = (ms = 5000) =>
  useQuery({ queryKey: ["omp"], queryFn: api.omp, refetchInterval: ms });

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.saveSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}

export function useHookAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: "install" | "uninstall") =>
      kind === "install" ? api.installHooks() : api.uninstallHooks(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hooks"] }),
  });
}

export function useOmpAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: "install" | "uninstall") =>
      kind === "install" ? api.installOmp() : api.uninstallOmp(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["omp"] }),
  });
}

export function useSignalDevice() {
  return useMutation({
    mutationFn: (v: { id: string; signal: DeviceSignal }) => api.signalDevice(v.id, v.signal),
  });
}

export function useVoice() {
  return useMutation({
    mutationFn: (v: { text: string; device: string; dryRun: boolean }) =>
      api.voice(v.text, v.device, v.dryRun),
  });
}

/**
 * Live camera frames, pushed by the daemon (SSE) rather than polled. Inside Tauri the Rust side holds the
 * stream (it owns the token) and re-emits `camera-frame`; in a plain browser an EventSource uses the dev proxy.
 */
export function useCameraStream(id: string | undefined, enabled: boolean) {
  const [frame, setFrame] = useState<CameraFrame>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFrame(null);
    setError(null);
    if (!enabled || !id) return;
    if ("__TAURI_INTERNALS__" in window) {
      const subs = [
        listen<NonNullable<CameraFrame>>("camera-frame", (e) => setFrame(e.payload)),
        listen<string>("camera-error", (e) => setError(e.payload)),
      ];
      invoke("camera_start", { id }).catch((e) => setError(String(e)));
      return () => {
        invoke("camera_stop").catch(() => {});
        for (const sub of subs) sub.then((off) => off());
      };
    }
    const es = new EventSource(`/daemon/v1/devices/${id}/camera/stream`);
    es.onmessage = (e) => setFrame(JSON.parse(e.data));
    es.onerror = () => setError("stream interrupted");
    return () => es.close();
  }, [id, enabled]);
  return { frame, error };
}
