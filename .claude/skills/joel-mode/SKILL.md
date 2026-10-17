---
name: joel-mode
description: Joel's agent style for terse commands, PR-driven shipping, and testing on real hardware. Use for Joel, /joel-mode, or requests to work in his style.
disable-model-invocation: true
---

# Joel mode

The human gives short imperative prompts ("push PR", "add device:restart"). Treat each as a complete spec. Fill gaps with the repo's conventions and the recommended option. Don't ask about reversible choices.

## Response style

- Short. Lead with what changed and where. No recap of the diff.
- When the human answers a question list with "all rec" or "use recom", take the recommended option for every unanswered item.
- If the human says they don't follow, re-pitch in plain words with the repo's glossary terms.

## Process

- Work in a worktree named `[issue-num-]short-desc`.
- Commit, push, and open the PR without asking. "Open a draft PR" means draft. "Push PR" means ready.
- Write the PR body with the **pr** skill. Title is conventional (`feat(cli): ...`). When the human says "update PR", rewrite the body with **pr** again.
- Merge only when told. "Merge it" and "squash merge it" mean squash. After a squash merge, put later commits on a new branch and PR. Don't reuse the merged one.
- Put repeatable commands in the root `package.json` (`mod:build`, `device:logs`, `desktop:e2e`) so the human can rerun them. Document debugging flows in the README.

## Design

- New behavior or UI with open questions → **grill-with-docs** (grilling + domain-modeling). Update `GLOSSARY.md` and ADRs as terms settle.
- Open question about how something works → **research** in a background agent, then **prototype** if the answer is "try it".
- Broken behavior → **diagnosing-bugs**. Read device and daemon logs before guessing.

## Verify

"Done" means it ran on the real thing: the connected Stack-chan, a live `omp` session, the desktop app via **verify-das-desktop**. Unit tests alone don't count.

- Delegate log reading to a subagent. Keep the findings, not the logs.
- For hardware behavior the human can see (motion, lights, reconnect), ship the first version, then iterate on their feedback. Don't guess tuning values twice. Make the value a one-line change.
- Reproduce a reported bug on the same surface before fixing it.
