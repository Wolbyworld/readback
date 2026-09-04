import test from "node:test";
import assert from "node:assert/strict";
import { balanceQuizAnswerPositions, buildOpenAIRequest, extractOutputText, normalizeRequest } from "../extension/openai-request.js";
import { validateQuizShape } from "../extension/quiz-schema.js";

test("normalizes settings to safe defaults", () => {
  const input = normalizeRequest({ page: { title: "A", text: "x".repeat(400) }, settings: { questionCount: 900, optionCount: 1, level: "expert" } });
  assert.deepEqual(input.settings, { questionCount: 5, optionCount: 4, level: "apply" });
});

test("accepts challenge as the fourth quiz level", () => {
  const input = normalizeRequest({ page: { title: "A", text: "x".repeat(400) }, settings: { questionCount: 3, optionCount: 4, level: "challenge" } });
  assert.equal(input.settings.level, "challenge");
  const { request } = buildOpenAIRequest(input);
  const questionSchema = request.text.format.schema.properties.questions.items;
  assert.equal(questionSchema.properties.prompt.pattern, "^(Scenario|Comparison|Counterfactual):");
  assert.equal(questionSchema.properties.evidence.pattern, "^Evidence A: [^;]+; Evidence B: [^;]+$");
});

test("builds a Luna low-reasoning image request without storing it", () => {
  const input = normalizeRequest({
    page: { title: "Visual lesson", text: "x".repeat(400), screenshot: "data:image/jpeg;base64,QUJDRA==" },
    settings: { questionCount: 3, optionCount: 4, level: "apply" }
  });
  const { request, mediaRefs } = buildOpenAIRequest(input);
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.equal(request.reasoning.effort, "low");
  assert.equal(request.max_output_tokens, 4990);
  assert.deepEqual(mediaRefs, ["none", "page_view"]);
  assert.equal(request.input[0].content[1].type, "input_image");
  assert.equal(request.text.format.schema.properties.questions.minItems, 3);
});

test("extracts raw Responses API output text", () => {
  const text = extractOutputText({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] });
  assert.equal(text, "{\"ok\":true}");
});

test("rejects a question that refers to missing media", () => {
  const quiz = { questions: [{
    prompt: "A valid question?",
    options: ["Option alpha", "Option beta"],
    answer_index: 0,
    explanation: "Correct: The source supports a.",
    option_feedback: ["Fits: The source supports a.", "Fails: The source rejects b. Correct: The source supports a."],
    evidence: "A short source phrase",
    image_ref: "missing",
    image_alt: "A missing chart"
  }] };
  assert.match(validateQuizShape(quiz, 1, 2, ["none"]), /missing media/);
});

test("rejects incomplete misconception feedback", () => {
  const quiz = { questions: [{
    prompt: "A valid question?",
    options: ["Option alpha", "Option beta"],
    answer_index: 0,
    explanation: "Correct: The source supports a.",
    option_feedback: ["Fits: The source supports a.", "Fails: The source rejects b."],
    evidence: "A short source phrase",
    image_ref: "none",
    image_alt: ""
  }] };
  assert.match(validateQuizShape(quiz, 1, 2, ["none"]), /misconception/);
});

test("rejects a cut-off answer option", () => {
  const quiz = { questions: [{
    prompt: "A valid question?",
    options: ["A complete answer", "This answer ends with the"],
    answer_index: 0,
    explanation: "Correct: The source supports a complete answer.",
    option_feedback: ["Fits: The source supports a complete answer.", "Fails: This is incomplete. Correct: The source supports a complete answer."],
    evidence: "A short source phrase",
    image_ref: "none",
    image_alt: ""
  }] };
  assert.match(validateQuizShape(quiz, 1, 2, ["none"]), /incomplete option/);
});

test("rejects non-English script in learner-facing text", () => {
  const quiz = { questions: [{
    prompt: "A valid question?",
    options: ["A complete answer", "A corrupted answer 必要"],
    answer_index: 0,
    explanation: "Correct: The source supports a complete answer.",
    option_feedback: ["Fits: The source supports a complete answer.", "Fails: This is corrupted. Correct: The source supports a complete answer."],
    evidence: "A short source phrase",
    image_ref: "none",
    image_alt: ""
  }] };
  assert.match(validateQuizShape(quiz, 1, 2, ["none"]), /non-English script/);
});

test("balances correct-answer positions without separating feedback", () => {
  const quiz = { questions: Array.from({ length: 3 }, (_, questionIndex) => ({
    prompt: `Question ${questionIndex + 1}`,
    options: ["Correct", "Wrong alpha", "Wrong beta", "Wrong gamma"],
    answer_index: 0,
    option_feedback: ["Fits: correct", "Fails: alpha", "Fails: beta", "Fails: gamma"]
  })) };
  const values = [0.72, 0.11, 0.88, 0.43, 0.27, 0.91, 0.36, 0.64];
  let randomIndex = 0;
  balanceQuizAnswerPositions(quiz, () => values[randomIndex++ % values.length]);
  assert.equal(new Set(quiz.questions.map((question) => question.answer_index)).size, 3);
  for (const question of quiz.questions) {
    assert.equal(question.options[question.answer_index], "Correct");
    assert.equal(question.option_feedback[question.answer_index], "Fits: correct");
  }
});
