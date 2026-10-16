# DAS desktop feature map

Index of user-facing features. Each file: Sub-features, How to get to it, Driving it, Gotchas. Harness and selectors: `../SKILL.md`.

| Feature | File | Existing spec |
| --- | --- | --- |
| Shell, tabs, daemon status chip, offline state | [shell-and-offline.md](shell-and-offline.md) | `dashboard.e2e.ts`, `offline.e2e.ts` |
| Settings (roots, port, secrets, hooks, Jev style) | [settings.md](settings.md) | `settings.e2e.ts` |
| Command tab / Jev and Console voice routing | [command-and-console.md](command-and-console.md) | none |
| Window lifecycle and tray | [window-and-tray.md](window-and-tray.md) | `window.e2e.ts` |
| Rust `api` relay | [api-relay.md](api-relay.md) | `relay.e2e.ts` |

Not mapped yet: Overview, Debug, Serial (need a connected device or live sessions).
