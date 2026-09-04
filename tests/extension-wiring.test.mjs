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
  assert.match(panel, /chrome\.tabs\.onActivated/);
  assert.match(worker, /chrome\.tabs\.onUpdated/);
  assert.match(worker, /READBACK_TAB_RESET/);
});

test("the start screen exposes the three quiz controls", async () => {
  const html = await readFile(panelHtmlUrl, "utf8");

  assert.match(html, /id="quickSettings"/);
  assert.match(html, /name="questionCount"/);
  assert.match(html, /name="optionCount"/);
  assert.match(html, /name="level"/);
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
  assert.match(css, /font-size: 13px/);
  assert.match(css, /clamp\(26px, 7\.4vw, 28px\)/);
  assert.doesNotMatch(css, /\.answers button:hover \{ padding-left/);
});

test("a replacement keeps the saved quiz until a successful response arrives", async () => {
  const panel = await readFile(panelUrl, "utf8");
  const generation = panel.slice(panel.indexOf("async function generateQuiz"), panel.indexOf("function buildMediaMap"));

  assert.match(generation, /showScreen\("loading"\);/);
  assert.match(generation, /if \(!response\.ok\) throw new Error/);
  assert.match(generation, /state\.quiz = payload\.quiz;/);
  assert.ok(generation.indexOf("state.quiz = payload.quiz") > generation.indexOf("if (!response.ok)"));
  assert.doesNotMatch(generation, /state\.quiz\s*=\s*null/);
});

test("the stack card can shrink and scroll at short panel sizes", async () => {
  const css = await readFile(new URL("../extension/sidepanel.css", import.meta.url), "utf8");

  assert.match(css, /\.question-card \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /@media \(max-height: 640px\)[\s\S]*?\.question-card \{ inset: 22px 23px 12px 17px;/);
  assert.match(css, /\.quick-options input:checked \+ span \{[^}]*border: 2px solid var\(--blue\);/);
  assert.doesNotMatch(css, /input:checked \+ span \{[^}]*background: var\(--blue\)/);
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
