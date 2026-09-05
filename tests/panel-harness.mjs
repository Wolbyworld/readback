import { readFile } from "node:fs/promises";

export async function panelHarness(script) {
  const base = new URL("../extension/", import.meta.url);
  const html = await readFile(new URL("sidepanel.html", base), "utf8");
  const panel = (await readFile(new URL("sidepanel.js", base), "utf8"))
    .replaceAll('from "./', `from "${base.href}`).replace(/initialize\(\);\s*$/, "");
  return html.replace("<head>", `<head><base href="${base.href}">`)
    .replace('<script type="module" src="sidepanel.js"></script>', `<script type="module">
    const storedRecords = {};
    const calls = [];
    const tab = { id: 42, title: 'The source article', url: 'https://example.com/source' };
    let generateResponse;
    let extractedUrl = tab.url;
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async message => {
          calls.push(message);
          if (message.type === 'READBACK_EXTRACT_PAGE') return { ok: true, payload: { title: tab.title, url: extractedUrl, text: 'Source content with enough information for a useful quiz. '.repeat(15), images: [] } };
          if (message.type === 'READBACK_GENERATE_QUIZ') return generateResponse(message);
          return { ok: true, payload: {} };
        }
      },
      storage: {
        onChanged: { addListener() {} },
        session: { get: async key => ({ [key]: storedRecords[key] }), set: async records => Object.assign(storedRecords, structuredClone(records)), remove: async key => delete storedRecords[key] },
        local: { get: async () => ({}), set: async () => {} }
      },
      tabs: { query: async () => [tab], get: async () => tab }
    };
    ${panel}
    writeTabMedia = async () => {};
    readTabMedia = async () => ({});
    deleteTabMedia = async () => {};
    const makeQuiz = (prefix = 'Original') => ({
      title: 'The Cognitive Revolution', source_summary: 'Machines change the tasks people do.', model: 'gpt-5.6-luna',
      questions: Array.from({ length: 3 }, (_, index) => ({
        prompt: prefix + ' question ' + (index + 1) + ': How does cheaper cognitive work change the tasks that people can carry out, and which source idea supports that change?',
        options: ['Machines make more tasks affordable while people direct and check the work.', 'People must stop all cognitive work as soon as its price falls.', 'Lower prices mean that demand for useful work must also fall.'],
        answer_index: 0,
        option_feedback: ['Fits: People direct and check the work.', 'Fails: People still direct the work. Correct: Machines expand the tasks that become affordable.', 'Fails: Demand can grow. Correct: Lower costs can make more tasks affordable.'],
        explanation: 'Correct: Lower costs can make more tasks affordable while people direct and check the work.',
        evidence: 'A short source passage with the supporting idea.', image_ref: 'none', image_alt: ''
      }))
    });
    Object.assign(state, freshTabState(tab.id, tab), { quiz: makeQuiz(), quizSettings: { questionCount: 3, optionCount: 3, level: 'apply' }, keyStatus: { configured: true, mode: 'session' }, answers: [null, null, null] });
    const results = {};
    const tick = () => new Promise(resolve => setTimeout(resolve, 20));
    try {
      ${script}
    } catch (error) { results.error = error.stack; }
    parent.postMessage({ readbackTest: true, results, width: innerWidth, height: innerHeight }, '*');
    </script>`);
}

export function frameHarness(html, sizes) {
  const escaped = html.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<!doctype html><script>
    const results = [];
    addEventListener('message', event => {
      if (!event.data?.readbackTest) return;
      results.push(event.data);
      if (results.length !== ${sizes.length}) return;
      const output = document.createElement('pre');
      output.id = 'test-result';
      output.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(results))));
      document.body.append(output);
    });
  </script>${sizes.map(([width, height]) => `<iframe style="border:0;width:${width}px;height:${height}px" srcdoc="${escaped}"></iframe>`).join('')}`;
}
