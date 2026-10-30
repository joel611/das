import { expect, test } from "bun:test";
import { toDecisionResponse } from "./llm-decision";
import { parseIntentResponse } from "./router";

const questions = {
  intent: {
    instructions: "x",
    criteria: { project: "p", status: "s", other: "o" },
  },
};

test("turns a model reply into a decisions response the router parses", () => {
  const reply = '```json\n{"intent": {"probabilities": {"project": 3, "status": 1}}}\n```';
  const json = toDecisionResponse(reply, questions);
  expect(json.answers.intent).toMatchObject({ choice: "project", confidence: 0.75 });
  expect(parseIntentResponse(json)).toMatchObject({ intent: "project", confidence: 0.75 });
});

test("rejects a reply with no usable probabilities", () => {
  expect(() => toDecisionResponse('{"intent": {}}', questions)).toThrow("no probabilities");
  expect(() => toDecisionResponse("nope", questions)).toThrow("no JSON");
});
