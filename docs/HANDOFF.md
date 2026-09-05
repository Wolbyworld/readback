# Readback development handoff

Last updated: September 5, 2026.

## Local candidate: keyboard navigation, 0.2.3

When the panel has focus, A–E or 1–5 selects an available answer, Left/Right moves between questions (Next requires an answer), Escape cancels loading or returns to setup, and ? opens the shortcut list. Tab, Shift+Tab, Enter, Space, and setup radio arrows retain their native behavior. Starting a quiz requires activating its button. Text entry, composition, browser modifiers, held shortcut keys, and the help dialog do not trigger quiz shortcuts. Invalid answer indexes are rejected.

Focus moves to each new question, Next after answering, results after completion, and Cancel while loading. The help dialog starts at its heading so its first shortcuts remain visible in short panels.

Verification: focused Chrome browser tests cover keyboard state, focus, invalid choices, cancellation, and help at 240×420 and 414×800, plus the existing responsive-screen and results checks. Native keys were checked in the local browser preview. No live model calls were needed. Reload version 0.2.3 on the Air for native Vivaldi side-panel confirmation.

## Local candidate: responsive screens, 0.2.2

A long page title expanded the implicit app grid column to about 696 px in a 414 px panel, clipping the header and setup controls. The app now has an explicit zero-minimum grid column and a shrinkable header. Setup has bounded spacing instead of an automatic top margin, and controls stack at panel widths up to 420 px. Short screens scroll without shrinking their content. A browser regression covers all seven screens, long titles, and live width/height changes.

All 62 automated tests and both entry-point syntax checks passed. The screenshot's long title was also checked in the local preview at 414×1308 and after resizing to 240×420. The user confirmed this layout works on the Air before requesting keyboard navigation.

## Local candidate: Air test feedback

The isolated `codex/air-feedback` candidate is version `0.2.1`. It includes the Find on page work below and these changes:

- Question cards use their natural height, with internal scrolling for longer content. A separate grid row keeps Back, Next, and setup visible. Disabled navigation remains readable.
- Correct and incorrect answers have pale backgrounds, dark text, and explicit answer labels. Both tested text/background pairs exceed 4.5:1 contrast.
- Question transitions reset scroll and no longer depend on two animation-frame callbacks to reveal the next question. Leaving a quiz cancels stale transitions.
- Results use the existing Stack visual style. **Repeat this quiz** resets answers without calling OpenAI. **New questions** reads the same source URL and uses the current quiz's settings for a fresh request. Failure or cancellation keeps the completed quiz available.
- New-question generation rejects repeated question wording, ignoring case and punctuation, within the existing two-attempt limit. This does not detect semantic paraphrases. Model, prompt, schema, and token budgets are unchanged.

Evidence: all 61 automated tests passed, including Chrome browser fixtures at 240×420, 280×640, 320×520, 380×720, and 420×1100; both browser entry-point syntax checks passed. The narrow UI and results were also inspected in the local preview. No live model calls were made: fresh generation, repeat rejection, errors, cancellation, and source changes used controlled responses.

The initial incomplete render in Vivaldi on the Air was user-reported and was not reproduced on the Mini. Native Vivaldi and Chrome side-panel UAT, including a live **New questions** request on the Sequoia article, remains pending. The user installed the first candidate on the Air while it still carried version `0.2.0`; version `0.2.1` identifies the updated test package. Nothing has been pushed or publicly released.

## Local candidate: Find on page

Answer feedback now includes **Find on page** for text evidence. It searches the quiz's source tab, highlights matching passages for 45 seconds, and scrolls to the first match. Challenge evidence can highlight two passages. It checks the page URL before searching and again inside the page.

Matching tolerates whitespace, letter case, and typographic quote/dash changes. It does not guess a match for a summary or translation. Visual-only evidence has no text-search button. This change adds no model call, permission, or stored history.

To test the local candidate:

1. Reload the unpacked extension from `extension/` and reopen its side panel.
2. Resume an existing quiz, or create one from an English article. Answer a question and select **Find on page**.
3. Confirm that matching source text is highlighted and the quiz answer and progress stay the same.
4. Try Challenge evidence, wording that is absent from the page, and a second tab with a separate quiz.

Automated browser fixtures cover matching, hidden text, inline markup, missing evidence, changed URLs, and the feedback action. Native side-panel UAT in Chrome and Vivaldi is still required before release. The optional follow-up question is outside this candidate.

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
