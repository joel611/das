import { useSyncExternalStore } from "react";

/** How the Jev panel draws its animation. A per-machine display preference, kept in localStorage. */
export const JEV_STYLES = [
  { id: "orb", label: "Orb", hint: "The vector orb with spinning rings and a bar waveform." },
  { id: "ascii", label: "ASCII", hint: "The ring orb drawn in characters, with a voice scope." },
] as const;

export type JevStyle = (typeof JEV_STYLES)[number]["id"];

const KEY = "das.jevStyle";
const EVENT = "das:jev-style";
const DEFAULT: JevStyle = "orb";
let fallback: JevStyle | null = null; // used when storage is blocked

function read(): JevStyle {
  try {
    const v = localStorage.getItem(KEY);
    return JEV_STYLES.some((s) => s.id === v) ? (v as JevStyle) : (fallback ?? DEFAULT);
  } catch {
    return fallback ?? DEFAULT;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function setJevStyle(style: JevStyle) {
  fallback = style;
  try {
    localStorage.setItem(KEY, style);
  } catch {
    // Storage blocked: the choice lasts until the app reloads.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useJevStyle(): [JevStyle, (s: JevStyle) => void] {
  return [useSyncExternalStore(subscribe, read, () => DEFAULT), setJevStyle];
}
