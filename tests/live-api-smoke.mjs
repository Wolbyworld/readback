import assert from "node:assert/strict";

const source = `
Sleep helps the brain stabilize memories. New experiences are first encoded as fragile patterns of neural activity.
During deep sleep, the hippocampus replays parts of those patterns. Repeated activity helps the cortex build more stable memories.
Slow-wave sleep supports facts and events. REM sleep can help the brain connect ideas and process emotional memories.
Both stages form part of a larger cycle, and attention while awake still matters for strong learning.
`;

const response = await fetch("http://127.0.0.1:41739/api/quiz", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
  },
  body: JSON.stringify({
    page: { title: "Why sleep makes memories stick", text: source.repeat(2), images: [], diagrams: [], screenshot: null },
    settings: { questionCount: 3, optionCount: 4, level: "apply" }
  })
});

const payload = await response.json();
assert.equal(response.status, 200, payload.error);
assert.equal(payload.quiz.model, "gpt-5.6-luna");
assert.equal(payload.quiz.questions.length, 3);
assert.ok(payload.quiz.questions.every((question) => question.options.length === 4));
assert.ok(payload.quiz.questions.every((question) => question.prompt && question.explanation && question.evidence));
assert.ok(payload.quiz.questions.every((question) => question.option_feedback.length === 4));
process.stdout.write(`Live API smoke passed: ${payload.quiz.questions.length} English questions from ${payload.quiz.model}.\n`);
