import assert from "node:assert/strict";
import test from "node:test";
import { evidencePassages, findSourceEvidence, highlightSourceEvidence } from "../extension/source-evidence.js";

test("source evidence separates Challenge supports and excludes visual descriptions", () => {
  assert.deepEqual(evidencePassages('“Sleep helps the brain connect ideas.”'), ["Sleep helps the brain connect ideas."]);
  assert.deepEqual(evidencePassages("Evidence A: Sleep helps the brain connect ideas.; Evidence B: Attention helps encode memories."),
    ["Sleep helps the brain connect ideas.", "Attention helps encode memories."]);
  assert.deepEqual(evidencePassages("Evidence A: Visual: The blue bar is taller.; Evidence B: Attention helps encode memories."), ["Attention helps encode memories."]);
  assert.deepEqual(evidencePassages("Visual: The blue bar is taller."), []);
  assert.deepEqual(evidencePassages(null), []);
  assert.deepEqual(evidencePassages("Too short"), []);
});

test("source lookup targets the quiz tab and checks its URL before injection", async () => {
  const message = { tabId: 42, pageUrl: "https://example.com/article", evidence: "Sleep helps the brain connect ideas." };
  let calls = 0;
  const browser = {
    tabs: { get: async (id) => { assert.equal(id, 42); return { url: message.pageUrl }; } },
    scripting: { executeScript: async (options) => {
      calls++;
      assert.deepEqual(options.target, { tabId: 42 });
      assert.equal(options.func, highlightSourceEvidence);
      assert.deepEqual(options.args, [[message.evidence], message.pageUrl]);
      return [{ result: { status: "found", found: 1, total: 1 } }];
    } }
  };
  assert.equal((await findSourceEvidence(browser, message)).status, "found");
  browser.tabs.get = async () => ({ url: "https://example.com/changed" });
  assert.equal((await findSourceEvidence(browser, message)).status, "page_changed");
  assert.equal(calls, 1);
  browser.tabs.get = async () => { throw new Error("private page details"); };
  assert.deepEqual(await findSourceEvidence(browser, message), { status: "unavailable", found: 0 });
});
