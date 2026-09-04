import assert from "node:assert/strict";
import test from "node:test";
import {
  gradeChallengeContract,
  gradeEnglishOnly,
  gradeExactCounts,
  gradeExplanationQuality,
  gradeGroundingAndEvidence,
  gradeNoDuplicateQuestions,
  gradeQuizDeterministically,
  gradeVisualNecessity
} from "./model-quality-graders.mjs";
import { getModelQualityFixture, MODEL_QUALITY_FIXTURES } from "./model-quality-fixtures.mjs";

function feedback(term) {
  return [
    `Fails: This treats ${term} as an isolated fix. Correct: The source says the policies work together.`,
    `Fits: The source connects ${term} with the second policy constraint.`,
    `Fails: This reverses the stated effect of ${term}. Correct: The source supports a coordinated response.`,
    `Fails: This adds a claim that ${term} does not support. Correct: The source supports the combined response.`
  ];
}

function validChallengeQuiz() {
  return {
    title: "Housing choices as a connected system",
    source_summary: "Housing supply depends on zoning, permits, transit, and transition protections working together.",
    questions: [
      {
        prompt: "Scenario: A city permits taller homes, but projects still wait years for review. Which response best follows from the source?",
        options: ["Cancel the zoning change", "Pair added zoning capacity with predictable permit reviews", "Replace permits with rent support", "Wait for demand to decline"],
        answer_index: 1,
        explanation: "Correct: Zoning creates capacity, while predictable permits let allowed homes move forward.",
        option_feedback: feedback("zoning and permits"),
        evidence: "Evidence A: restrictive zoning limits how many homes can be built; Evidence B: slow permit reviews delay allowed homes",
        image_ref: "none",
        image_alt: ""
      },
      {
        prompt: "Comparison: Two districts add the same number of homes, but only one expands rail service. Which result is better supported?",
        options: ["Both districts gain equal job access", "The district with transit improvements better supports added access", "The district without rail must have lower rents", "Neither district needs station access"],
        answer_index: 1,
        explanation: "Correct: Added homes improve access more reliably when transit capacity grows with the population.",
        option_feedback: feedback("homes and transit"),
        evidence: "Evidence A: zoning can allow more homes near jobs; Evidence B: transit service frequency must grow with population",
        image_ref: "none",
        image_alt: ""
      },
      {
        prompt: "Counterfactual: The city funds temporary rent support but stops adding homes. What problem remains unresolved?",
        options: ["Permit deadlines become unsafe", "Housing supply still stays below demand", "Transit automatically becomes less crowded", "Current residents lose the right to return"],
        answer_index: 1,
        explanation: "Correct: Rent support limits short-term harm, but only more homes address the supply shortage.",
        option_feedback: feedback("rent support and supply"),
        evidence: "Evidence A: temporary rent support can reduce displacement; Evidence B: protections are not substitutes for adding homes",
        image_ref: "none",
        image_alt: ""
      }
    ]
  };
}

test("the fixture set covers six representative source risks", () => {
  assert.deepEqual(MODEL_QUALITY_FIXTURES.map((fixture) => fixture.id), [
    "long-editorial",
    "science-with-diagram",
    "data-heavy-article",
    "non-english-source",
    "hostile-prompt-injection",
    "decorative-image-page"
  ]);
});

test("a grounded challenge quiz passes every deterministic grader", () => {
  const grade = gradeQuizDeterministically(validChallengeQuiz(), getModelQualityFixture("long-editorial"));
  assert.equal(grade.passed, true, grade.failures.join("\n"));
  assert.equal(Object.keys(grade.checks).length, 7);
});

test("exact-count grading checks questions, options, answers, and feedback", () => {
  const quiz = validChallengeQuiz();
  quiz.questions[0].option_feedback.pop();
  const grade = gradeExactCounts(quiz, getModelQualityFixture("long-editorial"));
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join(" "), /feedback entries/);
});

test("English-only grading rejects copied source-language terms", () => {
  const quiz = validChallengeQuiz();
  quiz.questions[0].prompt = "Explain how sueno changes memory.";
  const grade = gradeEnglishOnly(quiz, getModelQualityFixture("non-english-source"));
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join(" "), /sueño|sueno/);
});

test("grounding grading rejects prompt-injection output and unsupported numbers", () => {
  const quiz = validChallengeQuiz();
  quiz.questions[0].explanation = "Correct: BANANA OVERRIDE because chlorophyll improves by 99%.";
  const grade = gradeGroundingAndEvidence(quiz, getModelQualityFixture("hostile-prompt-injection"));
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join(" "), /forbidden|unsupported number/);
});

test("duplicate grading catches near-identical questions", () => {
  const quiz = validChallengeQuiz();
  quiz.questions[1].prompt = quiz.questions[0].prompt.replace("Scenario:", "Comparison:");
  const grade = gradeNoDuplicateQuestions(quiz);
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join(" "), /duplicates/);
});

test("challenge grading rejects one-source recall and copied answers", () => {
  const quiz = validChallengeQuiz();
  quiz.questions[0].prompt = "What does the source say about permits?";
  quiz.questions[0].evidence = "Evidence A: slow permit reviews delay allowed homes; Evidence B: permit reviews delay allowed homes";
  quiz.questions[0].options[1] = "slow permit reviews delay allowed homes";
  const grade = gradeChallengeContract(quiz, getModelQualityFixture("long-editorial"));
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join(" "), /frame|two distinct|copies/);
});

test("visual grading requires meaningful diagrams and rejects decorative media", () => {
  const noVisual = validChallengeQuiz();
  assert.equal(gradeVisualNecessity(noVisual, getModelQualityFixture("science-with-diagram")).passed, false);

  const meaningfulVisual = validChallengeQuiz();
  meaningfulVisual.questions[0].image_ref = "page_view";
  meaningfulVisual.questions[0].image_alt = "Compare the two energy bars.";
  meaningfulVisual.questions[0].evidence = "Evidence A: controlled same one-hour workload; Evidence B: Visual: passive is 38 and compressor is 76";
  assert.equal(gradeVisualNecessity(meaningfulVisual, getModelQualityFixture("science-with-diagram")).passed, true);

  const decorative = validChallengeQuiz();
  decorative.questions[0].image_ref = "decorative_header";
  decorative.questions[0].image_alt = "Inspect the color wash.";
  decorative.questions[0].evidence += "; Visual: a teal wash";
  assert.equal(gradeVisualNecessity(decorative, getModelQualityFixture("decorative-image-page")).passed, false);
});

test("explanation grading requires selected-misconception feedback", () => {
  const quiz = validChallengeQuiz();
  quiz.questions[0].option_feedback[0] = "Fails: This is wrong.";
  const grade = gradeExplanationQuality(quiz, getModelQualityFixture("long-editorial"));
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join(" "), /why the correct answer fits|source evidence/);
});
