import { cleanup } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vite-plus/test";

// lib/api.ts picks the Tauri relay once, at import, by looking for this global. `mockIPC` fills in `invoke`.
Object.assign(window, { __TAURI_INTERNALS__: {} });

// jsdom lacks these; Base UI and Radix-style popups touch them.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
  onchange: null,
})) as typeof window.matchMedia;
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
  clearMocks();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
});
