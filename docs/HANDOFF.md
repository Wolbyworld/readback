# Readback development handoff

Last updated: September 5, 2026.

## Current state

Readback `0.2.0` is a working local development release. It has been tested as an unpacked extension in Chrome for Testing 152 and Vivaldi 7.7. It is not submitted to the Chrome Web Store and has no hosted backend.

The product decisions that should remain stable are:

- One question is visible at a time. Answered cards move up in a Stack motion.
- Every tab owns its own quiz, answers, and progress.
- Quiz setup supports 3, 5, 7, or 10 questions; 2 to 5 options; and Recall, Explain, Apply, or Challenge depth.
- Output is always English, even when the source page is not English.
- Useful page images, diagrams, SVGs, and canvases can become question evidence.
- A wrong answer gets choice-specific feedback, the correct explanation, and source evidence.
- Each user supplies their own OpenAI API key. Normal use does not need a server.

## Runtime flow

1. The toolbar action opens the native browser side panel.
2. The panel identifies the active tab and restores only that tab's saved session state.
3. The user chooses settings and selects **Make my quiz**.
4. The service worker extracts readable page text and up to three useful visuals. It uses a visible-page capture only when no useful page visual succeeds.
5. The service worker calls the OpenAI Responses API with `store: false` and a strict quiz schema.
6. The panel stores the quiz and answer progress in browser session storage under the tab ID.
7. Navigation or replacement generation cancels stale work so a late response cannot replace the current tab's quiz.

## Code map

| Area | Main files |
| --- | --- |
| Manifest and permissions | `extension/manifest.json` |
| Toolbar, extraction, OpenAI request ownership | `extension/service-worker.js` |
| Panel state and interaction | `extension/sidepanel.js` |
| Panel markup and visual system | `extension/sidepanel.html`, `extension/sidepanel.css` |
| API-key storage boundary | `extension/key-storage.js` |
| Request, prompt, and schema | `extension/openai-request.js`, `extension/prompt.js`, `extension/quiz-schema.js` |
| Stale-generation protection | `extension/generation-lifecycle.js` |
| Optional local evaluation service | `server/` |
| Automated behavior checks | `tests/*.test.mjs` |
| Model fixtures and graders | `tests/model-quality-*.mjs` |

## Start on another computer

1. Clone the private repository.
2. Run `npm test` with Node.js 20 or newer.
3. Open `chrome://extensions` or `vivaldi://extensions`.
4. Turn on Developer mode and select **Load unpacked**.
5. Select the repository's `extension` directory.
6. Open Readback on a normal web page and enter a test OpenAI API key through the panel.

Do not copy `.env.local`, browser profile data, extension storage, or an API key from another computer. Use a new or existing key through the product setup screen.

## Test strategy

Run this check before every commit that changes behavior:

```bash
npm test
node --check extension/service-worker.js
node --check extension/sidepanel.js
```

The automated suite covers extension wiring, per-tab state, page extraction, visual extraction, API-key storage, request failures, prompt rules, strict schema validation, deterministic quality grades, and overlapping generation lifecycles.

For a user-visible change, also perform this browser matrix:

| Flow | Chrome | Vivaldi |
| --- | --- | --- |
| Toolbar opens side panel | Required | Required |
| Text article creates and completes a quiz | Required | Required |
| Separate tabs keep separate progress | Required | Required |
| Wrong answer shows full feedback | Required | Required |
| Back to setup and replacement quiz work | Required | Required |
| A useful image or diagram appears in a question | Required | Required |

## Prompt and model calibration

The checked-in default is `gpt-5.6-luna`. Reasoning is low for Recall and Apply, medium for Explain, and high for Challenge. Do not change the model, schema, prompt, or graders from one anecdotal article.

Use the six representative fixtures and three runs per fixture:

```bash
npm start
READBACK_EVAL_RUNS=3 node tests/model-quality-eval.mjs
```

The evaluation writes ignored artifacts under `artifacts/evals/`. Keep them local because they contain page text and model output. The last completed calibration passed 18 of 18 quiz sets and 54 of 54 questions. A new model or prompt needs a new complete matrix plus browser UAT.

## Security and data boundary

- The key is stored only in `chrome.storage.local` or `chrome.storage.session`, based on the user's choice. It is not cryptographically protected from someone or software that already controls the browser profile.
- The service worker owns key access and the OpenAI call. The side panel clears the entered key after save and does not read back the stored value.
- Page text and useful visuals leave the browser only after an explicit quiz action.
- Page and model content are untrusted. Keep rendering on safe text and attribute paths.
- Do not add analytics, history, sync storage, or server persistence without a separate product and privacy decision.
- Never commit `.env.local`, evaluation artifacts, browser profiles, or captured user pages.

## Known limits

- Browser internal pages, extension stores, and other protected pages cannot be read.
- Quiz and answer progress use session storage and do not form a permanent learning history.
- Visual selection is heuristic. Decorative images can still need product tuning, and some protected or cross-origin visuals can fall back to a visible-page capture.
- The extension is a local development release. Store listing, privacy disclosures, packaging, update delivery, and public support are not complete.
- Browser UAT is manual. The Node suite does not prove Chrome and Vivaldi UI behavior by itself.

## Release checklist

- Confirm the working tree is clean and review the full diff.
- Run the automated and syntax checks.
- Run the Chrome and Vivaldi browser matrix.
- Run a complete model-quality matrix after any model, prompt, schema, or grader change.
- Scan the working tree and Git history for secrets.
- Confirm the manifest version and README status match.
- Keep Chrome Web Store submission, public release, and any backend deployment behind separate approval.
