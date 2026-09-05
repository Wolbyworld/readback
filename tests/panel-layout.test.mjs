import assert from "node:assert/strict";
import test from "node:test";
import { browser, runBrowserHarness } from "./browser-harness.mjs";
import { frameHarness, panelHarness } from "./panel-harness.mjs";

test("quiz content scrolls within compact cards while navigation stays visible at panel sizes", { skip: !browser }, async () => {
  const html = await panelHarness(`
    renderQuestion(); showScreen('quiz');
    const rect = selector => { const r = $(selector).getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, height:r.height, width:r.width }; };
    results.before = { card:rect('#questionCard'), footer:rect('.quiz-actions'), next:rect('#nextButton'), opacity:getComputedStyle($('#nextButton')).opacity };
    chooseAnswer(1);
    results.after = { card:rect('#questionCard'), footer:rect('.quiz-actions'), next:rect('#nextButton'), scrollHeight:$('#questionCard').scrollHeight, clientHeight:$('#questionCard').clientHeight, enabled:!$('#nextButton').disabled, overflow:document.documentElement.scrollWidth > innerWidth };
    const wrong = document.querySelector('.answers .is-wrong');
    const right = document.querySelector('.answers .is-correct');
    results.wrong = { text:getComputedStyle(wrong).color, background:getComputedStyle(wrong).backgroundColor, cue:wrong.querySelector('.answer-state').textContent };
    results.right = { text:getComputedStyle(right).color, background:getComputedStyle(right).backgroundColor, cue:right.querySelector('.answer-state').textContent };
    $('#questionCard').scrollTop = 10000;
    nextQuestion();
    await new Promise(resolve => setTimeout(resolve, 400));
    results.next = { index:state.index, scroll:$('#questionCard').scrollTop, opacity:getComputedStyle($('#questionCard')).opacity, animating:state.animating };
    state.answers = [0,1,0]; renderResults();
    results.results = { overflow:document.documentElement.scrollWidth > innerWidth, primary:$('#newQuizButton').innerText, repeat:$('#retryButton').innerText, width:rect('#newQuizButton').width, scrollHeight:$('#resultsScreen').scrollHeight, clientHeight:$('#resultsScreen').clientHeight };
    state.quiz.questions[0].prompt = 'Which idea fits?'; state.quiz.questions[0].options = ['One idea','Another idea']; state.index = 0; state.answers = [null,null,null]; renderQuestion(); showScreen('quiz');
    results.compact = { card:rect('#questionCard'), stage:rect('.card-stage') };
  `);
  const runs = await runBrowserHarness(frameHarness(html, [[240,420],[280,640],[320,520],[380,720],[420,1100]]));
  for (const { results: r, width, height } of runs) {
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.after.footer.bottom <= height + 1, `${width}x${height}: footer clipped`);
    assert.ok(r.after.next.right <= width && r.after.next.left >= 0);
    assert.ok(r.after.next.height >= 44 && r.after.next.width >= 90);
    assert.ok(r.after.card.bottom <= r.after.footer.top);
    assert.equal(r.after.enabled, true);
    assert.equal(r.after.overflow, false);
    assert.equal(r.before.opacity, '1');
    assert.match(r.wrong.cue, /Your answer.*Incorrect/);
    assert.match(r.right.cue, /Correct answer/);
    assert.ok(contrast(r.wrong.text, r.wrong.background) >= 4.5);
    assert.ok(contrast(r.right.text, r.right.background) >= 4.5);
    assert.equal(r.next.index, 1);
    assert.equal(r.next.scroll, 0);
    assert.equal(r.next.animating, false);
    assert.equal(Number(r.next.opacity), 1, `${width}x${height}: next question stays transparent`);
    assert.equal(r.results.overflow, false);
    assert.match(r.results.primary, /New questions/);
    assert.match(r.results.repeat, /Repeat this quiz/);
    if (height === 1100) assert.ok(r.compact.card.height < r.compact.stage.height - 100, 'short card must not stretch');
  }
});

function contrast(first, second) {
  const luminance = value => value.match(/[\d.]+/g).slice(0,3).map(Number).map(x => {
    x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
  }).reduce((total, value, index) => total + value * [.2126,.7152,.0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}
