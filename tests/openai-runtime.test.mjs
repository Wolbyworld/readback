import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAIRequest, createQuizWithOpenAI, OPENAI_CHALLENGE_TIMEOUT_MS, OPENAI_TIMEOUT_MS, validateGenerationInput } from "../extension/openai-request.js";

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

test("the direct Responses request uses Luna, high Challenge reasoning, strict schema, and every visual", () => {
  const { request, mediaRefs } = buildOpenAIRequest(validInput());
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.deepEqual(request.reasoning, { effort: "high" });
  assert.equal(request.max_output_tokens, 14990);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.properties.questions.items.properties.prompt.pattern, "^(Scenario|Comparison|Counterfactual):");
  assert.equal(request.text.format.schema.properties.source_summary.pattern, "^[^\\n]+[.!?]$");
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

test("Challenge gets more time without slowing the normal levels", () => {
  assert.equal(OPENAI_TIMEOUT_MS, 110000);
  assert.equal(OPENAI_CHALLENGE_TIMEOUT_MS, 180000);
});

test("an invalid model quiz is retried once before it reaches the learner", async () => {
  const makeQuestion = (index) => ({
    prompt: `Scenario: Combine source ideas for case ${index + 1}.`,
    options: ["Complete correct answer", "Plausible wrong answer", "Different wrong answer", "Final wrong answer"],
    answer_index: 0,
    explanation: "Correct: The two source ideas support the complete answer.",
    option_feedback: [
      "Fits: The two source ideas support this answer.",
      "Fails: This misses the first idea. Correct: Both source ideas support the answer.",
      "Fails: This reverses the second idea. Correct: Both source ideas support the answer.",
      "Fails: This adds an outside claim. Correct: Both source ideas support the answer."
    ],
    evidence: "Evidence A: The first source idea applies; Evidence B: The second source idea also applies",
    image_ref: "none",
    image_alt: ""
  });
  const validQuiz = { title: "A complete quiz", source_summary: "Two linked ideas support each answer.", questions: Array.from({ length: 3 }, (_, index) => makeQuestion(index)) };
  const invalidQuiz = structuredClone(validQuiz);
  invalidQuiz.questions[0].options[0] += " 必要";
  let calls = 0;
  const invalidReasons = [];
  const fetchImpl = async () => {
    calls += 1;
    const quiz = calls === 1 ? invalidQuiz : validQuiz;
    return new Response(JSON.stringify({ output_text: JSON.stringify(quiz) }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const quiz = await createQuizWithOpenAI(validInput(), PLACEHOLDER_KEY, {
    fetchImpl,
    random: () => 0.4,
    onInvalid: (failure) => invalidReasons.push(failure)
  });
  assert.equal(calls, 2);
  assert.deepEqual(invalidReasons, [{ attempt: 1, reason: "Question 1 contains non-English script." }]);
  assert.equal(quiz.questions.length, 3);
  assert.equal(new Set(quiz.questions.map((question) => question.answer_index)).size, 3);
});

test("a summary must end as a complete sentence", async () => {
  const input = validInput();
  const question = {
    prompt: "Scenario: Combine the two source ideas for this case.",
    options: ["Complete correct answer", "First wrong answer", "Second wrong answer", "Third wrong answer"],
    answer_index: 0,
    explanation: "Correct: The two source ideas support the complete answer.",
    option_feedback: [
      "Fits: The two source ideas support this answer.",
      "Fails: This misses the first idea. Correct: Both ideas support the answer.",
      "Fails: This reverses the second idea. Correct: Both ideas support the answer.",
      "Fails: This adds an outside claim. Correct: Both ideas support the answer."
    ],
    evidence: "Evidence A: The first source idea applies; Evidence B: The second source idea also applies",
    image_ref: "none",
    image_alt: ""
  };
  const invalidQuiz = { title: "A quiz", source_summary: "This summary stops at the", questions: [question, question, question] };
  const fetchImpl = async () => new Response(JSON.stringify({ output_text: JSON.stringify(invalidQuiz) }), { status: 200 });
  const invalidReasons = [];
  await assert.rejects(
    createQuizWithOpenAI(input, PLACEHOLDER_KEY, { fetchImpl, onInvalid: (failure) => invalidReasons.push(failure.reason) }),
    (error) => error.code === "QUIZ_INVALID"
  );
  assert.deepEqual(invalidReasons, ["The quiz has no usable summary.", "The quiz has no usable summary."]);
});

test("new questions reject repeated prompts within the existing two-attempt limit", async () => {
  const input = validInput();
  const makeQuiz = prefix => ({ title: "A complete quiz", source_summary: "The source supports these linked ideas.", questions: Array.from({ length: 3 }, (_, index) => ({
    prompt: `Scenario: ${prefix} source ideas for case ${index + 1}.`,
    options: ["Complete correct answer", "First wrong answer", "Second wrong answer", "Third wrong answer"],
    answer_index: 0,
    explanation: "Correct: The two source ideas support this conclusion.",
    option_feedback: ["Fits: Both source ideas support this conclusion.", "Fails: This misses one idea. Correct: Combine both source ideas.", "Fails: This reverses the ideas. Correct: Combine both source ideas.", "Fails: This adds a claim. Correct: Combine both source ideas."],
    evidence: "Evidence A: The first idea applies; Evidence B: The second idea supports this conclusion",
    image_ref: "none", image_alt: ""
  })) });
  const repeated = makeQuiz('Combine');
  const fresh = makeQuiz('Compare');
  const previousQuestions = repeated.questions.map(q => q.prompt.toUpperCase().replace('.', '!'));
  let calls = 0;
  const reasons = [];
  const result = await createQuizWithOpenAI(input, PLACEHOLDER_KEY, { previousQuestions,
    fetchImpl: async () => new Response(JSON.stringify({ output_text: JSON.stringify(++calls === 1 ? repeated : fresh) })),
    onInvalid: failure => reasons.push(failure.reason)
  });
  assert.equal(calls, 2);
  assert.match(result.questions[0].prompt, /Compare/);
  assert.deepEqual(reasons, ["A question from the previous quiz was repeated."]);
  calls = 0;
  await assert.rejects(createQuizWithOpenAI(input, PLACEHOLDER_KEY, { previousQuestions,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ output_text: JSON.stringify(repeated) })); }
  }), error => error.code === 'QUIZ_REPEATED');
  assert.equal(calls, 2);
});
