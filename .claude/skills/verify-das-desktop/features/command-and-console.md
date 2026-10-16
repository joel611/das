# Command tab (Jev) and Console

## Sub-features
- Command: running agents panel, Jev orb + conversation log, command box `#jev-cmd`, usage panel.
- Console: typed stand-in for speech; `Dry run` checkbox `#dry` on by default; unchecking shows red `Real requests` alert and each send needs `Yes, send for real`; `New conversation`.
- Both post to `POST /v1/voice` (via the `api` relay).

## How to get to it (user POV)
Command is the default tab; Console is the `Console` tab.

## Driving it with WDIO
- Type in `#jev-cmd` (or the Console textarea), press Enter / `button[aria-label="Send to Jev"]` / `button=Send`.
- Without an OpenRouter key (sandbox default) the Routing card says `OpenRouter key: NOT set (requests will error)` and a dry-run send yields an error reply (`OPENROUTER_API_KEY is not set` from `packages/cli/src/router.ts`). That is the observable end state in the sandbox.
- Real-send gate: uncheck `#dry`, send, expect `[role="alertdialog"]`, click `Cancel`; assert no session started (`GET /v1/state` sessions unchanged). **Never click `Yes, send for real`**: it starts a real Claude session.
- A dry-run success path needs a model response; only possible by writing a key into the sandbox config (`config.yml` `openrouterKey`) which still hits the live OpenRouter API. Do that only with the user's OK.

## Gotchas
- No existing spec. Journey that needs an OpenRouter key reports failure with reason; do not weaken it.
- Real sends are the one non-sandboxable action; keep `#dry` checked.
