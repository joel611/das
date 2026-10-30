import { join } from "node:path";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { config, DEFAULT_ORCHESTRATOR_MODELS, type Config } from "./config";
import { createOrchestrator } from "./orchestrator";
import { defaultPiAuthFile, PiAuthFile } from "./pi-auth";
import { jevDecider, jevIntentClassifier } from "./router";
import type { Project } from "./scanner";
import type { Session } from "./sessions";
import { spawners } from "./spawner";

type ModelSetup = { models: MutableModels; provider: string; modelId: string; via: string };

/**
 * OpenAI through your ChatGPT subscription: the OAuth login pi saved (`openai`, or the legacy
 * `openai-codex`). pi-ai refreshes the token and writes it back to the same file, under pi's lock.
 */
export async function openaiSubscriptionModels(
  c: Pick<Config, "orchestratorModel" | "piAuthFile">,
): Promise<ModelSetup> {
  const file = c.piAuthFile || defaultPiAuthFile();
  const credentials = new PiAuthFile(file);
  const provider = (
    await Promise.all(
      ["openai", "openai-codex"].map(async (id) =>
        (await credentials.read(id))?.type === "oauth" ? id : null,
      ),
    )
  ).find(Boolean);
  if (!provider)
    throw new Error(`no OpenAI subscription login in ${file}: run pi, then /login and pick OpenAI`);
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  models.setProvider(openaiCodexProvider());
  return {
    models,
    provider,
    modelId: c.orchestratorModel || DEFAULT_ORCHESTRATOR_MODELS.openai,
    via: `${provider} login in ${file}`,
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
