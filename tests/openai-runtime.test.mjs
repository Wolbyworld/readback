import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAIRequest, createQuizWithOpenAI, validateGenerationInput } from "../extension/openai-request.js";

const PLACEHOLDER_KEY = "not-a-real-api-key-value-12345";
const PIXEL = "data:image/png;base64,QUJDRA==";

function validInput() {
  return validateGenerationInput({
    page: {
      title: "A visual lesson",
      url: "https://example.com/lesson",
      text: "A grounded lesson about two linked ideas. ".repeat(12),
      images: [
        { ref: "visual_1", alt: "First diagram", dataUrl: PIXEL },
        { ref: "visual_2", alt: "Second diagram", dataUrl: PIXEL }
      ],
      diagrams: [{ ref: "visual_1", label: "First diagram", visibleText: "A then B" }],
      screenshot: null
    },
    settings: { questionCount: 3, optionCount: 4, level: "challenge" }
  });
}

test("the direct Responses request uses Luna, low reasoning, strict schema, and every visual", () => {
  const { request, mediaRefs } = buildOpenAIRequest(validInput());
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.deepEqual(request.reasoning, { effort: "low" });
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.properties.questions.items.properties.prompt.pattern, "^(Scenario|Comparison|Counterfactual):");
  assert.deepEqual(mediaRefs, ["none", "visual_1", "visual_2"]);
  assert.deepEqual(request.input[0].content.slice(1).map((item) => item.image_url), [PIXEL, PIXEL]);
});

test("generation inputs reject invalid settings and malformed visuals", () => {
  const body = {
    page: { title: "A", text: "x".repeat(400), images: [{ ref: "bad ref", dataUrl: PIXEL }], diagrams: [], screenshot: null },
    settings: { questionCount: 4, optionCount: 4, level: "expert" }
  };
  assert.throws(() => validateGenerationInput(body), (error) => error.code === "INVALID_SETTINGS");
  body.settings = { questionCount: 3, optionCount: 4, level: "apply" };
  assert.throws(() => validateGenerationInput(body), (error) => error.code === "INVALID_PAGE");
});

test("missing, invalid, and rate-limited keys return safe product errors", async () => {
  const input = validInput();
  await assert.rejects(createQuizWithOpenAI(input, ""), (error) => error.code === "MISSING_API_KEY");

  const invalidResponse = () => Promise.resolve(new Response(
    JSON.stringify({ error: { message: `rejected ${PLACEHOLDER_KEY}` } }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  ));
  await assert.rejects(
    createQuizWithOpenAI(input, PLACEHOLDER_KEY, { fetchImpl: invalidResponse }),
    (error) => error.code === "INVALID_API_KEY" && !error.message.includes(PLACEHOLDER_KEY)
  );

  const limitedResponse = () => Promise.resolve(new Response("{}", { status: 429 }));
  await assert.rejects(
    createQuizWithOpenAI(input, PLACEHOLDER_KEY, { fetchImpl: limitedResponse }),
    (error) => error.code === "RATE_LIMITED" && error.status === 429
  );

  const networkFailure = () => Promise.reject(new Error(`network error with ${PLACEHOLDER_KEY}`));
  await assert.rejects(
    createQuizWithOpenAI(input, PLACEHOLDER_KEY, { fetchImpl: networkFailure }),
    (error) => error.code === "OPENAI_NETWORK" && !error.message.includes(PLACEHOLDER_KEY)
  );
});

test("a slow OpenAI request stops at the timeout with a safe error", async () => {
  const neverCompletes = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await assert.rejects(
    createQuizWithOpenAI(validInput(), PLACEHOLDER_KEY, { fetchImpl: neverCompletes, timeoutMs: 1 }),
    (error) => error.code === "OPENAI_TIMEOUT"
  );
});
