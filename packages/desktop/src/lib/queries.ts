import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import type { DeviceSignal, SettingsPatch } from "./types";

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
