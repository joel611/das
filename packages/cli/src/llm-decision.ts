import { config } from "./config";
import { openaiSubscriptionModels, openrouterModels } from "./orchestrator-start";

type Question = { instructions: string; criteria: Record<string, string> };
type DecisionBody = { model: string; state: unknown; questions: unknown };

const SYSTEM =
  "You answer multiple-choice questions about the given state. For each question pick exactly one " +
  "criteria key and give a probability for every key (summing to 1). Reply with only JSON shaped " +
  '{"<question>": {"probabilities": {"<key>": <number>, ...}}}.';

/** Pull the JSON object out of a reply, tolerating a code fence or surrounding prose. */
function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("classifier reply has no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Turn the model's reply into the decisions API response shape, so the router parses both alike.
 * The confidence of a choice is the probability the model gave it.
 */
export function toDecisionResponse(text: string, questions: Record<string, Question>) {
  const reply = extractJson(text);
  const answers: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    const raw: Record<string, unknown> = reply?.[name]?.probabilities ?? {};
    const probabilities = Object.fromEntries(
      Object.keys(q.criteria).map((k) => [k, Math.max(0, Number(raw[k]) || 0)]),
    );
    const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
    if (!total) throw new Error(`classifier gave no probabilities for "${name}"`);
    for (const k of Object.keys(probabilities)) probabilities[k] /= total;
    const [choice, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
    answers[name] = { choice, confidence, probabilities };
  }
  return { answers };
}

/** Answer a decisions-API request with a chat completion on the configured classifier provider. */
export async function llmDecision(body: DecisionBody, c = config) {
  const setup =
    c.classifierProvider === "openai"
      ? await openaiSubscriptionModels({
          orchestratorModel: body.model,
          codexAuthFile: c.codexAuthFile,
        })
      : openrouterModels({ orchestratorModel: body.model });
  const model = setup.models.getModel(setup.provider, setup.modelId);
  if (!model) throw new Error(`unknown classifier model ${setup.provider}/${setup.modelId}`);
  const reply = await setup.models.complete(model, {
    systemPrompt: SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({ state: body.state, questions: body.questions }),
        timestamp: Date.now(),
      },
    ],
  });
  if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "classifier model error");
  const text = reply.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  return toDecisionResponse(text, body.questions as Record<string, Question>);
}
