import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { gradeQuizDeterministically } from "./model-quality-graders.mjs";
import { MODEL_QUALITY_FIXTURES } from "./model-quality-fixtures.mjs";

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : null;
assert.ok(sourcePath, "Pass one complete model-quality artifact to regrade.");

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const fixtures = new Map(MODEL_QUALITY_FIXTURES.map((fixture) => [fixture.id, fixture]));
assert.equal(source.runCount, 3, "The source artifact must contain three runs per fixture.");
assert.equal(source.results?.length, MODEL_QUALITY_FIXTURES.length * source.runCount, "The source artifact is not a complete matrix.");

const results = source.results.map((entry) => {
  const fixture = fixtures.get(entry.fixtureId);
  assert.ok(fixture, `Unknown fixture: ${entry.fixtureId}`);
  assert.ok(entry.quiz, `${entry.fixtureId} run ${entry.run} has no generated quiz.`);
  assert.equal(entry.quiz.model, source.model, `${entry.fixtureId} run ${entry.run} used another model.`);
  const grade = gradeQuizDeterministically(entry.quiz, fixture);
  process.stdout.write(`${grade.passed ? "PASS" : "FAIL"} ${entry.fixtureId} run ${entry.run}: ${grade.failures.length} failures.\n`);
  return { ...entry, grade };
});

const failures = results.filter((entry) => !entry.grade.passed);
assert.equal(failures.length, 0, failures.flatMap((entry) => entry.grade.failures.map((failure) => `${entry.fixtureId} run ${entry.run}: ${failure}`)).join("\n"));

const evaluatedAt = new Date().toISOString();
const artifact = `${JSON.stringify({
  ...source,
  evaluatedAt,
  regradedFrom: basename(sourcePath),
  results
}, null, 2)}\n`;
const artifactDirectory = resolve("artifacts/evals");
const immutablePath = resolve(artifactDirectory, `model-quality-${evaluatedAt.replace(/[:.]/g, "-")}.json`);
await mkdir(artifactDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(artifactDirectory, "model-quality-current.json"), artifact),
  writeFile(immutablePath, artifact)
]);

process.stdout.write(`${source.model} quality regrade passed for ${results.length} saved quiz sets.\n`);
process.stdout.write(`Immutable output: ${immutablePath}\n`);
