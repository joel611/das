interface Window {
  // Injected by `withGlobalTauri` in the e2e config overlay.
  // oxlint-disable-next-line typescript/no-explicit-any
  __TAURI__: any;
}
