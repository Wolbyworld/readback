import assert from "node:assert/strict";
import test from "node:test";
import { browser, runBrowserHarness } from "./browser-harness.mjs";
import { frameHarness, panelHarness } from "./panel-harness.mjs";

test("all screens fit a narrow panel with long page titles and setup has no growing empty gap", { skip: !browser }, async () => {
  const html = await panelHarness(`
    state.pageTitle = 'Incredulidad ante la versión sobre Ceuta y sensación de fin de etapa en el PSOE: "El relato no funciona"';
    state.quiz.title = state.pageTitle;
    $('#pageTitle').textContent = state.pageTitle;
    $('#errorMessage').textContent = 'The source page could not be read. Please return to the original article and try again.';
    updateSettingsUI(); updateKeyStatusUI();
    results.screens = {};
    for (const name of ['start','key','access','loading','quiz','results','error']) {
      if (name === 'quiz') renderQuestion();
      if (name === 'results') { state.answers = [0,1,0]; buildResults(); }
      showScreen(name);
      const screen = screens[name];
      const r = screen.getBoundingClientRect();
      const controls = [...screen.querySelectorAll('button, .quick-options span, .key-form > input')]
        .filter(element => element.getClientRects().length)
        .map(element => { const box = element.getBoundingClientRect(); return {text:element.textContent,left:box.left,right:box.right,height:box.height}; });
      const shell = $('.app-shell');
      results.screens[name] = { width:r.width, scrollWidth:screen.scrollWidth,clientWidth:screen.clientWidth,
        shellScroll:shell.scrollWidth,shellClient:shell.clientWidth,controls };
      screen.scrollTop = screen.scrollHeight;
      const last = [...screen.querySelectorAll('button')].filter(element => element.getClientRects().length).at(-1);
      const lastRect = last?.getBoundingClientRect();
      results.screens[name].lastButtonReachable = !lastRect || (lastRect.top >= 58 && lastRect.bottom <= innerHeight + 1);
      screen.scrollTop = 0;
    }
    showScreen('start');
    results.gap = $('#quickSettings').getBoundingClientRect().top - $('.key-status').getBoundingClientRect().bottom;
    results.initialSize = { width: innerWidth, height: innerHeight };
    results.resized = [];
    for (const [width,height] of [[240,420],[414,1308],[520,720]]) {
      frameElement.style.width = width + 'px'; frameElement.style.height = height + 'px';
      await tick();
      for (const name of ['start','key','access','loading','quiz','results','error']) {
        showScreen(name);
        const screen = screens[name];
        const clipped = [...screen.querySelectorAll('button, .quick-options span')].filter(element => element.getClientRects().length)
          .some(element => { const box=element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; });
        results.resized.push({name,width,height,actualWidth:innerWidth,clipped,overflow:screen.scrollWidth > screen.clientWidth + 2});
      }
    }
  `);
  const runs = await runBrowserHarness(frameHarness(html, [[240,420],[280,640],[380,720],[414,1308],[520,720]]));
  for (const { results:r } of runs) {
    assert.equal(r.error,undefined,r.error);
    const {width,height}=r.initialSize;
    for (const [name,screen] of Object.entries(r.screens)) {
      const at = `${name} ${width}x${height}`;
      assert.ok(screen.width <= width, `${at}: grid exceeds panel width`);
      assert.ok(screen.shellScroll <= screen.shellClient + 2, `${at}: app overflows`);
      assert.ok(screen.scrollWidth <= screen.clientWidth + 2, `${at}: content overflows`);
      for (const control of screen.controls) {
        assert.ok(control.left >= -1 && control.right <= width + 1, `${at}: clipped control ${control.text}`);
      }
      assert.equal(screen.lastButtonReachable,true,`${at}: last action is not reachable`);
    }
    assert.ok(r.gap >= 20 && r.gap <= 32, `${width}x${height}: setup gap is ${r.gap}`);
    for (const resize of r.resized) {
      assert.equal(resize.actualWidth,resize.width);
      assert.equal(resize.clipped,false,JSON.stringify(resize));
      assert.equal(resize.overflow,false,JSON.stringify(resize));
    }
  }
});
