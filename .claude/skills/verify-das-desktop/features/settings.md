# Settings

## Sub-features
- Root folders (`#roots`, one per line), port (`#port`), token (`#token`) and OpenRouter key (`#key`, write-only; placeholder `(set) type to replace`).
- Save (`button=Save`) with toast `Saved.` (port change adds a restart hint).
- Hooks install/uninstall for Claude (backup of `settings.json` first) and the omp extension.
- Jev animation style group (`aria-label="Jev animation style"`, `aria-pressed`), stored on this machine (UI only).

## How to get to it (user POV)
Tab `Settings` in the header.

## Driving it with WDIO
- Round trip: `e2e/settings.e2e.ts` (daemon up, refresh, edit `#roots`, Save, toast, read `$DAS_CONFIG_DIR/config.yml`).
- Hooks: click `button=Install hooks`; side effects to read: `$CLAUDE_CONFIG_DIR/settings.json` contains the hook entries for `process.env.PORT`, and a backup file next to it; then `Uninstall hooks` removes them. Same for omp under `$PI_CODING_AGENT_DIR`.
- Jev style: click a button in the group, expect its `aria-pressed="true"`, open Command tab and screenshot the Jev panel.

## Gotchas
- Settings are polled once a minute: after `startDaemon()` call `browser.refresh()` or fields stay empty/disabled (Save is disabled until loaded).
- Saving rewrites the YAML and drops comments; assert on contents, not byte equality.
- Hooks/omp flows are not covered by an existing spec; never run them without the sandbox env (real `~/.claude` would be modified).
