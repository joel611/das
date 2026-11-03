import { createClaudeWorker } from "./claude";
import { createPiWorker } from "./pi";
import type { Workers } from "./worker";

export type {
  Integration,
  IntegrationStatus,
  SpawnResult,
  Worker,
  WorkerId,
  Workers,
} from "./worker";

/** Every worker. An agent's config dir, when given, turns on its integration. */
export function createWorkers(dirs: { claudeDir?: string; piDir?: string } = {}): Workers {
  return {
    claude: createClaudeWorker({ dir: dirs.claudeDir }),
    pi: createPiWorker({ dir: dirs.piDir }),
  };
}
