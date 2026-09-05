import assert from "node:assert/strict";
import test from "node:test";
import { browser, runBrowserHarness } from "./browser-harness.mjs";
import { frameHarness, panelHarness } from "./panel-harness.mjs";

test("keyboard answers, navigation, focus, help and cancellation stay inside the active panel flow", { skip: !browser }, async () => {
  const html = await panelHarness(`
    const press = (key, options = {}, target = document.activeElement) => {
      const event = new KeyboardEvent('keydown', { key, bubbles:true, cancelable:true, ...options });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 180));
    renderQuestion(); showScreen('quiz');
    results.initialFocus = document.activeElement.id;
    press('ArrowRight'); await settle();
    results.unansweredIndex = state.index;
    press('5'); press('E'); chooseAnswer(-1); chooseAnswer(99); chooseAnswer(1.5);
    results.invalidAnswer = state.answers[0];
    for (const options of [{ctrlKey:true},{metaKey:true},{altKey:true},{isComposing:true},{repeat:true}]) press('a', options);
    const editor = document.createElement('div'); editor.contentEditable = 'true'; document.body.append(editor);
    press('a', {}, editor); editor.remove();
    press('a', {}, $('#apiKeyInput'));
    results.guardedAnswer = state.answers[0];
    results.answerPrevented = press('B');
    results.chosen = { answer:state.answers[0], focus:document.activeElement.id };
    press('a'); results.locked = state.answers[0];
    press('ArrowRight', {repeat:true}); await settle();
    results.repeatIndex = state.index;
    press('ArrowRight'); await settle();
    results.next = { index:state.index, focus:document.activeElement.id };
    press('?');
    results.help = { open:$('#shortcutsDialog').open, focus:document.activeElement.id, fits:$('#shortcutsDialog').scrollWidth <= $('#shortcutsDialog').clientWidth };
    press('a'); press('ArrowLeft'); await settle();
    results.modalGuard = { answer:state.answers[1], index:state.index };
    $('#shortcutsCloseButton').click(); await tick();
    results.helpClosed = { open:$('#shortcutsDialog').open, focus:document.activeElement.id };
    press('1'); press('ArrowLeft'); await settle();
    results.back = { index:state.index, answer:state.answers[0], focus:document.activeElement.id };
    press('ArrowRight'); await settle(); press('ArrowRight'); await settle();
    press('3'); press('ArrowRight');
    results.completed = { screen:state.screen, focus:document.activeElement.id, answers:[...state.answers] };
    press('Escape');
    results.setup = { screen:state.screen, hasQuiz:Boolean(state.quiz), focus:document.activeElement.tagName };
    updateSettingsUI();
    const radio = $('#quickSettings input'); radio.focus();
    results.nativeRadio = !press('ArrowRight');
    press('a'); press('n'); press('Enter');
    results.noImplicitRequest = calls.filter(x => x.type === 'READBACK_GENERATE_QUIZ').length;
    renderResults();
    let finish;
    generateResponse = () => new Promise(resolve => { finish = resolve; });
    $('#newQuizButton').focus(); $('#newQuizButton').click(); await tick();
    results.loadingFocus = document.activeElement.id;
    press('Escape'); await tick();
    finish({ok:true,payload:{quiz:makeQuiz('Late')}}); await tick();
    results.cancelled = { screen:state.screen, original:!state.quiz.questions[0].prompt.startsWith('Late') };
    retryQuiz();
    results.repeatFocus = document.activeElement.id;
    // Every supported answer key must map to the displayed choice, including five-choice quizzes.
    state.quiz.questions[0].options.push('Fourth option', 'Fifth option');
    results.mapping = [];
    for (const key of ['a','b','c','d','e','1','2','3','4','5']) {
      state.answers[0] = null; renderQuestion(); press(key);
      results.mapping.push(state.answers[0]);
    }
  `);
  for (const size of [[240,420],[414,800]]) {
    const [{ results:r }] = await runBrowserHarness(frameHarness(html, [size]));
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.initialFocus, 'questionText');
    assert.equal(r.unansweredIndex, 0);
    assert.equal(r.invalidAnswer, null);
    assert.equal(r.guardedAnswer, null);
    assert.equal(r.answerPrevented, true);
    assert.deepEqual(r.chosen, {answer:1,focus:'nextButton'});
    assert.equal(r.locked, 1);
    assert.equal(r.repeatIndex, 0);
    assert.deepEqual(r.next, {index:1,focus:'questionText'});
    assert.deepEqual(r.help, {open:true,focus:'shortcutsTitle',fits:true});
    assert.deepEqual(r.modalGuard, {answer:null,index:1});
    assert.deepEqual(r.helpClosed, {open:false,focus:'questionText'});
    assert.deepEqual(r.back, {index:0,answer:1,focus:'questionText'});
    assert.deepEqual(r.completed, {screen:'results',focus:'resultTitle',answers:[1,0,2]});
    assert.deepEqual(r.setup, {screen:'start',hasQuiz:true,focus:'H1'});
    assert.equal(r.nativeRadio, true);
    assert.equal(r.noImplicitRequest, 0);
    assert.equal(r.loadingFocus, 'cancelButton');
    assert.deepEqual(r.cancelled, {screen:'results',original:true});
    assert.equal(r.repeatFocus, 'questionText');
    assert.deepEqual(r.mapping, [0,1,2,3,4,0,1,2,3,4]);
  }
});
