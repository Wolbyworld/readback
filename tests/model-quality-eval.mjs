import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gradeQuizDeterministically } from "./model-quality-graders.mjs";
import { MODEL_QUALITY_FIXTURES } from "./model-quality-fixtures.mjs";

const endpoint = "http://127.0.0.1:41739/api/quiz";
const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

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

for (const fixture of MODEL_QUALITY_FIXTURES) {
  const quiz = await createQuiz(fixture);
  assert.equal(quiz.model, "gpt-5.6-luna", `${fixture.id}: unexpected generation model`);
  const grade = gradeQuizDeterministically(quiz, fixture);
  assert.ok(grade.passed, `${fixture.id} failed deterministic grading:\n${grade.failures.join("\n")}`);
  process.stdout.write(`PASS ${fixture.id}: ${Object.keys(grade.checks).length} deterministic graders.\n`);
}

process.stdout.write(`Luna quality eval passed for ${MODEL_QUALITY_FIXTURES.length} representative fixtures.\n`);
