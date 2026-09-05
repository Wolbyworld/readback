import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../extension/service-worker.js", import.meta.url);
const panelUrl = new URL("../extension/sidepanel.js", import.meta.url);
const panelHtmlUrl = new URL("../extension/sidepanel.html", import.meta.url);
const manifestUrl = new URL("../extension/manifest.json", import.meta.url);

test("the toolbar click opens the side panel before asynchronous storage", async () => {
  const source = await readFile(workerUrl, "utf8");
  const handler = source.slice(
    source.indexOf("chrome.action.onClicked.addListener"),
    source.indexOf("async function extractActivePage")
  );

  assert.ok(handler.includes("chrome.sidePanel.open"));
  assert.ok(handler.includes("chrome.storage.session.set"));
  assert.ok(handler.indexOf("chrome.sidePanel.open") < handler.indexOf("chrome.storage.session.set"));
  assert.doesNotMatch(handler, /addListener\(async/);
});

test("fallback open-on-action behavior is configured at worker load", async () => {
  const source = await readFile(workerUrl, "utf8");

  assert.match(source, /configureSidePanel\(\);/);
  assert.match(source, /const useBrowserManagedOpening = !chrome\.sidePanel\.open/);
  assert.match(source, /openPanelOnActionClick:\s*useBrowserManagedOpening/);
});

test("quiz state is stored and restored by browser tab", async () => {
  const [worker, panel] = await Promise.all([
    readFile(workerUrl, "utf8"),
    readFile(panelUrl, "utf8")
  ]);

  assert.match(panel, /const TAB_STATE_PREFIX = "readbackTab:"/);
  assert.match(panel, /tabStateKey\(state\.tabId\)/);
  assert.match(panel, /quizSettings: state\.quizSettings/);
  assert.match(panel, /state\.quizSettings\?\.level \|\| state\.settings\.level/);
  assert.match(panel, /chrome\.tabs\.onActivated/);
  assert.match(panel, /setInterval\(syncActiveTab, 750\)/);
  assert.match(panel, /const changedTab = tab\.id !== state\.tabId/);
  assert.match(panel, /const changedPage = !changedTab/);
  assert.match(panel, /await resetTab\(tab\.id, tab\)/);
  assert.match(worker, /chrome\.tabs\.onUpdated/);
  assert.match(worker, /READBACK_TAB_RESET/);
});

test("the start screen exposes all quiz controls including Challenge", async () => {
  const html = await readFile(panelHtmlUrl, "utf8");

  assert.match(html, /id="quickSettings"/);
  assert.match(html, /name="questionCount"/);
  assert.match(html, /name="optionCount"/);
  assert.match(html, /name="level"/);
  assert.match(html, /name="level" value="challenge"/);
  assert.match(await readFile(panelUrl, "utf8"), /challenge: "Combine two source ideas in a new scenario\."/);
  assert.doesNotMatch(html, /id="settingsDialog"/);
});

test("the quiz gives immediate locked feedback and keeps setup available", async () => {
  const [panel, html, css] = await Promise.all([
    readFile(panelUrl, "utf8"),
    readFile(panelHtmlUrl, "utf8"),
    readFile(new URL("../extension/sidepanel.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="answerFeedback"/);
  assert.match(html, /id="quizSetupButton"/);
  assert.match(html, /id="resultsSetupButton"/);
  assert.match(panel, /function renderAnswerFeedback/);
  assert.match(panel, /textContent = correct \? "Correct" : "Not quite"/);
  assert.match(panel, /question\.option_feedback\?\.\[selectedAnswer\]/);
  assert.match(panel, /button\.disabled = selectedAnswer != null/);
  assert.match(panel, /state\.answers\[state\.index\] != null\) return/);
  assert.match(panel, /function returnToSetup/);
  assert.match(panel, /Make a replacement quiz/);
  assert.match(css, /\.answers button \{[^}]*font-size: 14px/);
  assert.match(css, /clamp\(22px, 6\.5vw, 28px\)/);
  assert.doesNotMatch(css, /\.answers button:hover \{ padding-left/);
});

test("a replacement keeps the saved quiz until a successful response arrives", async () => {
  const panel = await readFile(panelUrl, "utf8");
  const generation = panel.slice(panel.indexOf("async function generateQuiz"), panel.indexOf("function buildMediaMap"));

  assert.match(generation, /showScreen\("loading"\);/);
  assert.match(generation, /type: "READBACK_GENERATE_QUIZ"/);
  assert.match(generation, /state\.quiz = generated\.quiz;/);
  assert.ok(generation.indexOf("state.quiz = generated.quiz") > generation.indexOf("if (!generated?.quiz"));
  assert.doesNotMatch(generation, /state\.quiz\s*=\s*null/);
});

test("same-tab navigation cancels generation and rejects a late page response", async () => {
  const panel = await readFile(panelUrl, "utf8");
  const reset = panel.slice(panel.indexOf("async function resetTab"), panel.indexOf("function renderCurrentState"));
  const generation = panel.slice(panel.indexOf("async function generateQuiz"), panel.indexOf("function cancelGeneration"));

  assert.match(reset, /state\.tabId === tabId && state\.abortController/);
  assert.match(reset, /cancelGeneration\(false\)/);
  assert.ok(reset.indexOf("cancelGeneration(false)") < reset.indexOf("chrome.storage.session.remove"));
  assert.match(generation, /let generationPageUrl = state\.pageUrl/);
  assert.match(generation, /state\.pageUrl !== generationPageUrl/);
  assert.match(generation, /state\.generationRequestId !== requestId/);
});

test("the stack card can shrink and scroll at short panel sizes", async () => {
  const css = await readFile(new URL("../extension/sidepanel.css", import.meta.url), "utf8");

  assert.match(css, /\.question-card \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /\.quiz-screen\.is-active \{ display: grid; grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.quick-options input:checked \+ span \{[^}]*border: 2px solid var\(--blue\);/);
  assert.doesNotMatch(css, /input:checked \+ span \{[^}]*background: var\(--blue\)/);
  assert.match(css, /html, body \{ min-width: 0;/);
  assert.match(css, /\.quiz-actions \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 280px\)[\s\S]*?\.depth-field \.quick-options \{[^}]*repeat\(2,/);
});

test("direct panel use can request website access with clear UI", async () => {
  const [manifestText, panel, html] = await Promise.all([
    readFile(manifestUrl, "utf8"),
    readFile(panelUrl, "utf8"),
    readFile(panelHtmlUrl, "utf8")
  ]);
  const manifest = JSON.parse(manifestText);

  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.match(panel, /chrome\.permissions\.request/);
  assert.match(panel, /HOST_ACCESS_REQUIRED/);
  assert.match(html, /id="accessScreen"/);
  assert.match(html, /Allow website access/);
});

test("normal use calls OpenAI from the service worker without localhost", async () => {
  const [manifestText, worker, panel] = await Promise.all([
    readFile(manifestUrl, "utf8"),
    readFile(workerUrl, "utf8"),
    readFile(panelUrl, "utf8")
  ]);
  const manifest = JSON.parse(manifestText);

  assert.deepEqual(manifest.host_permissions, ["https://api.openai.com/*"]);
  assert.equal(manifest.background.type, "module");
  assert.match(worker, /createQuizWithOpenAI/);
  assert.match(worker, /READBACK_GENERATE_QUIZ/);
  assert.match(panel, /READBACK_GENERATE_QUIZ/);
  assert.doesNotMatch(`${manifestText}\n${panel}`, /127\.0\.0\.1|localhost/);
  assert.doesNotMatch(panel, /\bfetch\s*\(/);
});

test("the open panel keeps long Vivaldi generations alive and stops cleanly", async () => {
  const [worker, panel] = await Promise.all([
    readFile(workerUrl, "utf8"),
    readFile(panelUrl, "utf8")
  ]);

  assert.match(worker, /case "READBACK_KEEP_ALIVE"/);
  assert.match(panel, /function startGenerationKeepAlive/);
  assert.match(panel, /READBACK_KEEP_ALIVE/);
  assert.match(panel, /startGenerationKeepAlive\(requestId\)/);
  assert.match(panel, /finally \{\s*stopGenerationKeepAlive\(requestId\);/);
  assert.match(panel, /function cancelGeneration[\s\S]*?stopGenerationKeepAlive\(requestId\);/);
  assert.match(panel, /const ownsRequest = state\.generationRequestId === requestId/);
  assert.match(panel, /if \(ownsRequest && ownsPage\) showScreen\("start"\)/);
});

test("key setup supports persistent, session-only, replace, and remove flows", async () => {
  const [worker, panel, html] = await Promise.all([
    readFile(workerUrl, "utf8"),
    readFile(panelUrl, "utf8"),
    readFile(panelHtmlUrl, "utf8")
  ]);

  assert.match(html, /id="keyScreen"/);
  assert.match(html, /type="password"/);
  assert.match(html, /name="keyMode" value="persistent"/);
  assert.match(html, /name="keyMode" value="session"/);
  assert.match(html, /Replace or remove/);
  assert.match(html, /Remove saved key/);
  assert.match(panel, /input\.value = "";/);
  assert.match(worker, /READBACK_KEY_STATUS/);
  assert.match(worker, /READBACK_SAVE_API_KEY/);
  assert.match(worker, /READBACK_REMOVE_API_KEY/);
  assert.doesNotMatch(`${worker}\n${panel}`, /storage\.sync/);
});

test("extension storage is limited to trusted extension contexts", async () => {
  const [worker, keyStorage] = await Promise.all([
    readFile(workerUrl, "utf8"),
    readFile(new URL("../extension/key-storage.js", import.meta.url), "utf8")
  ]);

  assert.match(worker, /configureStorageAccess\(chrome\.storage\)/);
  assert.equal((keyStorage.match(/accessLevel: "TRUSTED_CONTEXTS"/g) || []).length, 2);
});
