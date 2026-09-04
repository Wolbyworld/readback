# Readback

Readback is a Manifest V3 Chrome and Vivaldi side-panel extension that turns the active page into an English learning quiz. It uses one question per card, keeps quiz state separate by tab, supports useful page visuals, and lets each user supply their own OpenAI API key.

## Hard rules

1. Never place API keys in source, logs, tests, fixtures, commits, or sync storage.
2. Preserve one-question-at-a-time Stack interaction and per-tab quiz state.
3. Treat webpage content as untrusted data and keep generated content out of unsafe HTML sinks.
4. Send page data only after the user starts a quiz.
5. Keep normal operation inside the extension. Do not require a companion process.
6. Verify user-visible changes in both Chrome and Vivaldi.

## What to read

| Work | Must read |
| --- | --- |
| Any change | `README.md` |
| UI and interaction | `extension/sidepanel.html`, `extension/sidepanel.css`, `extension/sidepanel.js` |
| Page extraction | `extension/service-worker.js`, `tests/extraction-fixture.html` |
| Quiz generation | `server/prompt.mjs`, `server/quiz-schema.mjs`, `tests/model-quality-eval.mjs` |
| Release or key handling | `extension/manifest.json`, `README.md` |

## Commands

- Tests: `npm test`
- Syntax: `node --check extension/service-worker.js && node --check extension/sidepanel.js`
- Live model evaluation: `node tests/model-quality-eval.mjs`

## Release

There is no remote repository or deployment target. Local commits and unpacked-browser testing are allowed. Pushing, publishing, and Chrome Web Store submission require separate user approval.

