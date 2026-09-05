import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { highlightSourceEvidence } from "../extension/source-evidence.js";
import { browser, reportResult, runBrowserHarness } from "./browser-harness.mjs";

test("browser finds exact visible passages across inline markup without changing page text", { skip: !browser }, async () => {
  const results = await runBrowserHarness(`<!doctype html><meta charset="utf-8">
    <nav>Hidden navigation is not evidence.</nav>
    <div hidden>Hidden source should not match.</div>
    <div style="opacity:0"><p>Invisible source should not match.</p></div>
    <textarea>Editable source should not match.</textarea>
    <article style="margin-top:1200px">
      <p>Sleep helps the <em>brain</em> <strong>connect</strong> ideas.</p>
      <p>Attention\n helps encode memories.</p>
      <p>It’s a well–supported connection.</p>
    </article>
    <script>
      const highlightSourceEvidence = ${highlightSourceEvidence.toString()};
      const originalText = document.querySelector('article').textContent;
      const results = {};
      const find = (passages, url = location.href) => highlightSourceEvidence(passages, url);
      results.found = find(['Sleep helps the brain connect ideas.', 'Attention helps encode memories.']);
      results.ranges = [...CSS.highlights.get('readback-source-evidence')].map(range => range.toString());
      results.scrolled = scrollY > 0;
      results.unchanged = originalText === document.querySelector('article').textContent;
      results.punctuation = find(["It's a well-supported connection."]);
      results.partial = find(['Attention helps encode memories.', 'This translated wording is absent.']);
      results.missing = find(['This translated wording is absent.']);
      results.cleared = !CSS.highlights.has('readback-source-evidence');
      results.hidden = find(['Hidden navigation is not evidence.', 'Hidden source should not match.', 'Invisible source should not match.', 'Editable source should not match.']);
      results.wordBoundary = find(['tention helps encode memories']);
      results.navigation = find(['Attention helps encode memories.'], 'https://example.com/old');
      ${reportResult}
    </script>`);
  assert.deepEqual(results.found, { status: "found", found: 2, total: 2 });
  assert.equal(results.ranges[0], "Sleep helps the brain connect ideas.");
  assert.equal(results.ranges[1].replace(/\s+/g, " "), "Attention helps encode memories.");
  assert.equal(results.scrolled, true);
  assert.equal(results.unchanged, true);
  assert.equal(results.punctuation.found, 1);
  assert.deepEqual(results.partial, { status: "found", found: 1, total: 2 });
  assert.equal(results.missing.status, "not_found");
  assert.equal(results.cleared, true);
  assert.equal(results.hidden.status, "not_found");
  assert.equal(results.wordBoundary.status, "not_found");
  assert.equal(results.navigation.status, "page_changed");
});

test("answer feedback offers source lookup after answering and keeps missing evidence honest", { skip: !browser }, async () => {
  const base = new URL("../extension/", import.meta.url);
  let html = await readFile(new URL("sidepanel.html", base), "utf8");
  let panel = await readFile(new URL("sidepanel.js", base), "utf8");
  panel = panel.replaceAll('from "./', `from "${base.href}`).replace(/initialize\(\);\s*$/, "");
  const results = await runBrowserHarness(html.replace("<head>", `<head><base href="${base.href}">`)
    .replace('<script type="module" src="sidepanel.js"></script>', `<script type="module">
    let response = { status: 'found', found: 1, total: 1 };
    let lastMessage;
    globalThis.chrome = {
      runtime: { onMessage: { addListener() {} }, sendMessage: async message => { lastMessage = message; return { ok: true, payload: response }; } },
      storage: { onChanged: { addListener() {} } }, tabs: {}
    };
    ${panel}
    const results = {};
    const question = { options: ['Correct choice', 'Wrong choice'], answer_index: 0,
      explanation: 'Correct: Sleep helps connect ideas.', option_feedback: ['Fits: Sleep helps.', 'Fails: Attention cannot replace sleep. Correct: Sleep helps connect ideas.'],
      evidence: 'Sleep helps the brain connect ideas.' };
    state.tabId = 42;
    state.pageUrl = 'https://example.com/article';
    renderAnswerFeedback(question, null);
    results.before = Boolean(document.querySelector('.evidence-link'));
    renderAnswerFeedback(question, 1);
    results.wrong = document.querySelector('.feedback-title').textContent;
    const click = async () => { document.querySelector('.evidence-link').click(); await new Promise(resolve => setTimeout(resolve, 0)); };
    await click();
    results.message = lastMessage;
    results.found = document.querySelector('.evidence-status').textContent;
    response = { status: 'not_found', found: 0 };
    await click();
    results.missing = document.querySelector('.evidence-status').textContent;
    response = { status: 'page_changed', found: 0 };
    await click();
    results.changed = document.querySelector('.evidence-status').textContent;
    results.enabled = !document.querySelector('.evidence-link').disabled;
    renderAnswerFeedback({ ...question, evidence: 'Visual: The blue bar is taller.' }, 1);
    results.visual = Boolean(document.querySelector('.evidence-link'));
    ${reportResult}
    </script>`));
  assert.equal(results.before, false);
  assert.equal(results.wrong, "Not quite");
  assert.deepEqual(results.message, { type: "READBACK_FIND_EVIDENCE", tabId: 42, pageUrl: "https://example.com/article", evidence: "Sleep helps the brain connect ideas." });
  assert.equal(results.found, "Source text highlighted on the page.");
  assert.match(results.missing, /not found.*summary or translation/);
  assert.match(results.changed, /page has changed/);
  assert.equal(results.enabled, true);
  assert.equal(results.visual, false);
});
