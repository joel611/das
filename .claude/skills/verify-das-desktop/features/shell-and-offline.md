# Shell, tabs, daemon status, offline state

## Sub-features
- Header `DAS` title and `nav[aria-label="Views"]` tab switching (Command, Overview, Console, Debug, Serial, Settings).
- Status chip `[role="status"]`: `daemon online · <headline>` vs `daemon not running`.
- Offline: pages show a `Daemon not reachable` alert instead of crashing.

## How to get to it (user POV)
Open the dashboard from the menu bar (`Open Dashboard`). Command tab is the default. Stop the daemon to see offline.

## Driving it with WDIO
- Shell: `e2e/dashboard.e2e.ts` (expects `h1` = `DAS`, clicks `button=Settings`, saves `e2e/settings.png`).
- Offline: `e2e/offline.e2e.ts` runs with no `startDaemon()`; waits up to 10s for chip text `daemon not running`, opens Settings, expects exactly one *visible* `//*[@role="alert"][contains(., "Daemon not reachable")]`.
- Online: add `startDaemon()` + `browser.refresh()`, expect chip text `daemon online`.
- Proof: `aria-current="page"` moves to the clicked tab; screenshot per tab.

## Gotchas
- Several alerts may exist in the DOM but only one is visible (hidden tabs); filter with `isDisplayed()`.
- The app polls `/v1/state` every 2s; allow a few seconds after daemon start/stop, or refresh.
- Sandbox daemon has no sessions or devices, so Overview/Command panels show empty states only.
