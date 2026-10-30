import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { config } from "./config";
import { createOrchestrator } from "./orchestrator";
import { jevDecider, jevIntentClassifier } from "./router";
import type { Project } from "./scanner";
import type { Session } from "./sessions";
import { spawners } from "./spawner";

/** The daemon's pi orchestrator: OpenRouter with the das key, its conversation in `<config dir>/orchestrator.sqlite`. */
export async function startPiOrchestrator(o: {
  dir: string;
  getProjects: () => Project[];
  getSessions: () => Session[];
}) {
  // The key is read live from the daemon's config (settings file or env), like the Jev classifiers.
  const models = createModels({
    authContext: {
      env: async (name) =>
        name === "OPENROUTER_API_KEY"
          ? config.openrouterKey || process.env[name]
          : process.env[name],
      fileExists: async () => false,
    },
  });
  models.setProvider(openrouterProvider());
  return createOrchestrator({
    storage: await openNodeSqliteStorage(join(o.dir, "orchestrator.sqlite")),
    models,
    model: { provider: "openrouter", modelId: config.orchestratorModel },
    getProjects: o.getProjects,
    getSessions: o.getSessions,
    decider: jevDecider,
    classifyIntent: jevIntentClassifier,
    spawners,
  });
}
