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
