import { join } from "node:path";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { config, DEFAULT_ORCHESTRATOR_MODELS, type Config } from "./config";
import { createOrchestrator } from "./orchestrator";
import { CODEX_PROVIDER, CodexAuthFile, defaultCodexAuthFile } from "./codex-auth";
import { jevDecider, jevIntentClassifier } from "./router";
import type { Project } from "./scanner";
import type { Session } from "./sessions";
import { spawners } from "./spawner";

type ModelSetup = { models: MutableModels; provider: string; modelId: string; via: string };

/**
 * OpenAI through your ChatGPT subscription: the login the Codex CLI saved in `~/.codex/auth.json`. pi-ai
 * refreshes the token and writes it back to the same file.
 */
export async function openaiSubscriptionModels(
  c: Pick<Config, "orchestratorModel" | "codexAuthFile">,
): Promise<ModelSetup> {
  const file = c.codexAuthFile || defaultCodexAuthFile();
  const credentials = new CodexAuthFile(file);
  if (!(await credentials.read(CODEX_PROVIDER)))
    throw new Error(`no ChatGPT login in ${file}: run \`codex login\``);
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());
  return {
    models,
    provider: CODEX_PROVIDER,
    modelId: c.orchestratorModel || DEFAULT_ORCHESTRATOR_MODELS.openai,
    via: `codex login in ${file}`,
  };
}

/** OpenRouter with the das key, read live from the daemon's config (settings file or env) like the Jev classifiers. */
function openrouterModels(c: Pick<Config, "orchestratorModel">): ModelSetup {
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
  return {
    models,
    provider: "openrouter",
    modelId: c.orchestratorModel || DEFAULT_ORCHESTRATOR_MODELS.openrouter,
    via: "OpenRouter key",
  };
}

/** The daemon's pi orchestrator, its conversation in `<config dir>/orchestrator.sqlite`. */
export async function startPiOrchestrator(o: {
  dir: string;
  getProjects: () => Project[];
  getSessions: () => Session[];
}) {
  const m =
    config.orchestratorProvider === "openai"
      ? await openaiSubscriptionModels(config)
      : openrouterModels(config);
  console.log(`pi orchestrator: ${m.provider}/${m.modelId} via ${m.via}`);
  return createOrchestrator({
    storage: await openNodeSqliteStorage(join(o.dir, "orchestrator.sqlite")),
    models: m.models,
    model: { provider: m.provider, modelId: m.modelId },
    getProjects: o.getProjects,
    getSessions: o.getSessions,
    decider: jevDecider,
    classifyIntent: jevIntentClassifier,
    spawners,
  });
}
