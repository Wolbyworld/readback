import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "extension");
const port = 41740;

const quiz = {
  title: "Why sleep makes memories stick",
  source_summary: "How sleep stages stabilize and connect memories.",
  model: "gpt-5.6-luna",
  questions: [
    { prompt: "A student wants a new fact to become stable. Which process from the page would help most?", options: ["Hippocampal replay during sleep", "Avoiding REM sleep", "Learning without attention", "One waking rest period"], answer_index: 0, option_feedback: ["Hippocampal replay gives the cortex repeated activity to stabilize the new memory.", "REM helps connect ideas, so avoiding it would not support learning.", "Attention helps encode a memory before sleep can strengthen it.", "Rest can help, but the page identifies replay during sleep as the main process."], explanation: "Replay helps the cortex build a more stable memory.", evidence: "Repeated activity helps the cortex build more stable memories.", image_ref: "none", image_alt: "" },
    { prompt: "Which stage is most closely linked to connecting ideas?", options: ["REM sleep", "Waking rest", "Slow-wave sleep only", "The first minute of sleep"], answer_index: 0, explanation: "REM sleep helps the brain connect ideas.", evidence: "REM sleep can help the brain connect ideas.", image_ref: "none", image_alt: "" },
    { prompt: "What does the blue section of the sleep-cycle diagram represent?", options: ["Deep sleep", "REM sleep", "Waking attention", "Memory loss"], answer_index: 0, explanation: "The diagram labels the blue section as deep sleep.", evidence: "The blue block is labelled deep sleep.", image_ref: "page_view", image_alt: "Inspect the blue section in the sleep-cycle diagram." },
    { prompt: "Why is attention while awake still important?", options: ["It helps encode the original memory", "It replaces all sleep cycles", "It prevents cortex activity", "It removes emotional memories"], answer_index: 0, explanation: "Sleep can strengthen only information that was first encoded.", evidence: "New experiences are first encoded as fragile patterns.", image_ref: "none", image_alt: "" },
    { prompt: "What best describes the role of both sleep stages?", options: ["They contribute different parts of one cycle", "They do exactly the same job", "Only REM stores facts", "Only deep sleep processes emotion"], answer_index: 0, explanation: "The stages have different roles inside a larger cycle.", evidence: "Both stages form part of a larger cycle.", image_ref: "none", image_alt: "" }
  ]
};

const shim = `
const demoScreenshot = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420"><rect width="800" height="420" fill="white"/><text x="40" y="60" font-family="Georgia" font-size="34">Sleep cycle</text><rect x="70" y="160" width="170" height="120" fill="#f7db23"/><rect x="300" y="100" width="170" height="180" fill="#ed3b2f"/><rect x="530" y="200" width="170" height="80" fill="#1647ff"/><text x="110" y="320" font-family="monospace" font-size="20">awake</text><text x="350" y="320" font-family="monospace" font-size="20">REM</text><text x="545" y="320" font-family="monospace" font-size="20">deep sleep</text></svg>');
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {} }
  },
  tabs: {
    query: async () => [{ id: 101, title: "Why sleep makes memories stick", url: "https://example.com/sleep" }],
    get: async () => ({ id: 101, title: "Why sleep makes memories stick", url: "https://example.com/sleep" })
  },
  permissions: { request: async () => true },
  runtime: {
    sendMessage: async () => ({ ok: true, payload: { title: "Why sleep makes memories stick", url: "https://example.com/sleep", text: "Sleep helps the brain stabilize memories. During deep sleep, the hippocampus replays recent patterns and repeated activity helps the cortex build stable memories. REM sleep helps connect ideas and process emotional memories. Attention while awake helps encode the original memory. ".repeat(3), images: [], diagrams: [], screenshot: demoScreenshot } })
  }
};
globalThis.fetch = async () => {
  await new Promise((resolve) => setTimeout(resolve, 180));
  return new Response(JSON.stringify({ quiz: ${JSON.stringify(quiz)} }), { status: 200, headers: { "Content-Type": "application/json" } });
};
addEventListener("DOMContentLoaded", () => {
  const wanted = new URLSearchParams(location.search).get("state") || "start";
  if (wanted === "loading") document.querySelector("#generateButton").click();
  if (wanted === "quiz" || wanted === "results") {
    document.querySelector("#generateButton").click();
    if (wanted === "results") {
      const advance = () => {
        if (!document.querySelector("#quizScreen.is-active")) return setTimeout(advance, 50);
        document.querySelector("#answers button")?.click();
        document.querySelector("#nextButton")?.click();
        if (document.querySelector("#resultsScreen.is-active")) return;
        setTimeout(advance, 360);
      };
      setTimeout(advance, 300);
    }
    if (wanted === "feedback") {
      const answer = () => {
        const firstAnswer = document.querySelector("#answers button");
        if (!firstAnswer) return setTimeout(answer, 50);
        firstAnswer.click();
      };
      setTimeout(answer, 300);
    }
  }
});
`;

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/chrome-shim.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      response.end(shim);
      return;
    }
    const filename = url.pathname === "/" || url.pathname === "/sidepanel.html" ? "sidepanel.html" : url.pathname.slice(1);
    const allowed = new Set(["sidepanel.html", "sidepanel.css", "sidepanel.js", "extraction-fixture.html"]);
    if (!allowed.has(filename)) throw new Error("Not found");
    const filePath = filename === "extraction-fixture.html" ? join(root, "tests", filename) : join(extensionRoot, filename);
    let content = await readFile(filePath, "utf8");
    if (filename === "sidepanel.html") content = content.replace('<script src="sidepanel.js"></script>', '<script src="/chrome-shim.js"></script><script src="/sidepanel.js"></script>');
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
    response.writeHead(200, { "Content-Type": `${types[extname(filename)]}; charset=utf-8`, "Cache-Control": "no-store" });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`UI harness ready at http://127.0.0.1:${port}\n`));
