import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gradeQuizDeterministically } from "./model-quality-graders.mjs";
import { MODEL_QUALITY_FIXTURES } from "./model-quality-fixtures.mjs";

const endpoint = "http://127.0.0.1:41739/api/quiz";
const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const runCount = Math.max(1, Math.min(5, Number(process.env.READBACK_EVAL_RUNS || 1)));
const artifactPath = resolve("artifacts/evals/model-quality-current.json");
const expectedModel = process.env.READBACK_EXPECTED_MODEL || "gpt-5.6-luna";
const requestedFixtures = new Set(String(process.env.READBACK_EVAL_FIXTURES || "").split(",").map((value) => value.trim()).filter(Boolean));
const selectedFixtures = requestedFixtures.size
  ? MODEL_QUALITY_FIXTURES.filter((fixture) => requestedFixtures.has(fixture.id))
  : MODEL_QUALITY_FIXTURES;

async function materializePage(fixture) {
  if (!fixture.screenshotAsset) return fixture.page;
  const image = await readFile(new URL(fixture.screenshotAsset, import.meta.url));
  return {
    ...fixture.page,
    screenshot: `data:image/png;base64,${image.toString("base64")}`
  };
}

async function createQuiz(fixture) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ page: await materializePage(fixture), settings: fixture.settings })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `${fixture.id}: ${payload.error}`);
  return payload.quiz;
}

const results = [];
for (const fixture of selectedFixtures) {
  for (let run = 1; run <= runCount; run += 1) {
    try {
      const quiz = await createQuiz(fixture);
      assert.equal(quiz.model, expectedModel, `${fixture.id}: unexpected generation model`);
      const grade = gradeQuizDeterministically(quiz, fixture);
      results.push({ fixtureId: fixture.id, description: fixture.description, run, quiz, grade });
      process.stdout.write(`${grade.passed ? "PASS" : "FAIL"} ${fixture.id} run ${run}: ${grade.failures.length} failures.\n`);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      results.push({ fixtureId: fixture.id, description: fixture.description, run, quiz: null, grade: { passed: false, failures: [failure] } });
      process.stdout.write(`FAIL ${fixture.id} run ${run}: ${failure}\n`);
    }
  }
}

await mkdir(resolve("artifacts/evals"), { recursive: true });
const generatedAt = new Date().toISOString();
const artifact = `${JSON.stringify({
  generatedAt,
  model: expectedModel,
  reasoning: "low for Recall and Apply; medium for Explain; high for Challenge",
  runCount,
  results
}, null, 2)}\n`;
const immutablePath = resolve(`artifacts/evals/model-quality-${generatedAt.replace(/[:.]/g, "-")}.json`);
await Promise.all([writeFile(artifactPath, artifact), writeFile(immutablePath, artifact)]);

const failures = results.filter((result) => !result.grade.passed);
assert.equal(failures.length, 0, [
  `${failures.length} of ${results.length} Luna quality evaluations failed.`,
  ...failures.flatMap((result) => result.grade.failures.map((failure) => `${result.fixtureId} run ${result.run}: ${failure}`)),
  `Full output: ${artifactPath}`,
  `Immutable output: ${immutablePath}`
].join("\n"));
process.stdout.write(`${expectedModel} quality eval passed for ${results.length} generated quiz sets across ${selectedFixtures.length} representative fixtures.\n`);
