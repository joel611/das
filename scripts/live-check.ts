// Live check (costs a few cents). Usage: bun scripts/live-check.ts jev | spawn <dir>
import { makeJevDecider, buildRequest, applyBands } from "../src/router";
import { claudeSpawner } from "../src/spawner";
import type { Project } from "../src/scanner";

const wt = (path: string, branch: string) => ({ path, branch });
const projects: Project[] = [
  { id: "/x/recipe-app", name: "recipe-app", path: "/x/recipe-app", worktrees: [wt("/x/recipe-app", "main")] },
  { id: "/x/ml-pipeline", name: "ml-pipeline", path: "/x/ml-pipeline", worktrees: [wt("/x/ml-pipeline", "main"), wt("/x/ml-pipeline-gpu", "feat/gpu")] },
  { id: "/x/stack-chan-server", name: "stack-chan-server", path: "/x/stack-chan-server", worktrees: [wt("/x/stack-chan-server", "main")] },
  { id: "/x/stack-chan-firmware", name: "stack-chan-firmware", path: "/x/stack-chan-firmware", worktrees: [wt("/x/stack-chan-firmware", "main")] },
];

if (process.argv[2] === "jev") {
  const key = process.env.OPENROUTER_API_KEY!;
  for (const t of ["add a vegetarian filter to the recipe search page", "fix the stack chan servo bug", "what's the weather today"]) {
    const t0 = performance.now();
    const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest(t, projects)),
    });
    const ms = Math.round(performance.now() - t0);
    const json: any = await res.json();
    console.log(t, res.status, ms + "ms", JSON.stringify({ answers: json.answers, usage: json.usage, error: json.error }));
    if (res.ok) {
      const d = await makeJevDecider({ apiKey: key, fetch: (async () => Response.json(json)) as any })(t, projects);
      console.log("  ->", d.project, d.confidence, applyBands(d), d.worktree);
    }
  }
} else if (process.argv[2] === "spawn") {
  console.log(await claudeSpawner(process.argv[3], "Reply with the single word OK and do nothing else.", "voice-livecheck"));
}
