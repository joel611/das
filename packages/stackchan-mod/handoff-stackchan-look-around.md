# Handoff: flash look_around MOD to Stack-chan

## Goal / status

User wanted `firmware/mods/examples/look_around` installed on the USB-connected Stack-chan (M5Stack CoreS3).
**Done**: MOD flashed and verified (digest matched at `0xfa0000`). Behavior on the robot (button A toggles random `lookAt` every 5s, else `lookAway`) was not visually confirmed.

## Device facts

- Port `/dev/cu.usbmodem1301`, ESP32-S3 QFN56 rev v0.2, 16MB flash, MAC `80:45:6b:56:23:84`.
- Currently runs host `9.0.0+stackchan.1` (built Aug 25 2026, IDF v6.0.2) — NOT the 9.5.0 host I deployed earlier; something reflashed it afterward.
- Partitions: nvs 0x9000, phy_init, factory 0x10000, **xs 0xfa0000 (0x40000)**, storage 0xfe0000.

## Key rule

`.xsa` must be built with the exact Moddable version of the host on the device. The repo (CI, `docs/migrations/moddable-9.5.md`, typings) targets **9.5.0**, so the repo's own default is 9.5.0, but the device currently needs **9.0.0**. Check the host version first by reading `0x10000` (256 bytes) and `strings` for `x.y.z+stackchan.1`; `npm run mod` also errors `Incompatible Moddable version: A != B` if mismatched.

## Environment installed (outside repo)

- `~/.local/share/moddable` — 10.0.1 (original, wrong for this repo; leave alone)
- `~/.local/share/moddable-9.5.0`, `~/.local/share/moddable-9.0.0` — cloned from tag, tools built (`make` in `build/makefiles/mac`, needs `build/bin/mac/release` on PATH for the xsbug step)
- `~/esp/esp-idf` v5.3.3 (original), `~/esp/esp-idf-6.1` (installed via `install.sh esp32s3`)
- `fontbm` is only in the old 10.0.1 SDK's `build/bin/mac/release`
- Need `mkdir -p $MODDABLE/build/tmp/esp32` or deploy fails on UPLOAD_PORT
- `esptool` comes from IDF 6.1 env (v5.5.0) after sourcing `export.sh`

## Commands

```
cd firmware
source env.sh            # defaults to Moddable 9.0.0; `source env.sh 9.5.0` for 9.5.0 hosts
npm run mod -- mods/examples/look_around/manifest.json   # MOD only, needs matching host
npm run build && npm run deploy                          # host firmware (OVERWRITES device firmware; user-approved once only)
```

Don't toggle DTR/RTS manually on the port — it drops the chip into download mode; recover with `esptool --chip esp32s3 --after hard-reset chip-id`.

## Repo state

- Branch `feat/poc`; untracked: `.claude/`, `firmware/mods/mod_poc/`, `firmware/env.sh` (plain copy, not committed — user asked for copy only).
- Leftover worktree `.claude/worktrees/env-sh` (branch `env-sh`?) holds an uncommitted copy of env.sh; can be removed (`git worktree remove`), ask user first.
- `source env.sh` was not run end-to-end (sandbox guard); content matches the working temp `env90.sh`.
- No tracked files were modified.

## Open items

- Optional: confirm look_around behaves on the robot (user to press button A).
- Optional: ask whether to delete the `env-sh` worktree/branch.
- If the user wants the 9.5.0 host back on the device, `npm run build && npm run deploy` with `source env.sh 9.5.0` (a 9.5.0 build already exists in `firmware/dist`), then re-flash the mod with 9.5.0.

## Suggested skills

- `diagnosing-bugs` — if the mod doesn't behave or flash fails again.
- `worktrunk:worktrunk` — only if cleaning up the `env-sh` worktree.
- Standing user rules: CLAUDE.md global (read before edit, worktree naming `[issue-num-]short-desc`).
