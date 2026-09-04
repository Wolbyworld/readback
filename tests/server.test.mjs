import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIRequest, extractOutputText, normalizeRequest } from "../server/server.mjs";
import { validateQuizShape } from "../server/quiz-schema.mjs";

test("normalizes settings to safe defaults", () => {
  const input = normalizeRequest({ page: { title: "A", text: "x".repeat(400) }, settings: { questionCount: 900, optionCount: 1, level: "expert" } });
  assert.deepEqual(input.settings, { questionCount: 5, optionCount: 4, level: "apply" });
});

test("builds a Luna low-reasoning image request without storing it", () => {
  const input = normalizeRequest({
    page: { title: "Visual lesson", text: "x".repeat(400), screenshot: "data:image/jpeg;base64,QUJDRA==" },
    settings: { questionCount: 3, optionCount: 4, level: "explain" }
  });
  const { request, mediaRefs } = buildOpenAIRequest(input);
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.equal(request.reasoning.effort, "low");
  assert.deepEqual(mediaRefs, ["none", "page_view"]);
  assert.equal(request.input[0].content[1].type, "input_image");
  assert.equal(request.text.format.schema.properties.questions.minItems, 3);
});

test("extracts raw Responses API output text", () => {
  const text = extractOutputText({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] });
  assert.equal(text, "{\"ok\":true}");
});

test("rejects a question that refers to missing media", () => {
  const quiz = { questions: [{ prompt: "A valid question?", options: ["a", "b"], answer_index: 0, image_ref: "missing" }] };
  assert.match(validateQuizShape(quiz, 1, 2, ["none"]), /missing media/);
});
