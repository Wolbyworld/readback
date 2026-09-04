import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildQuizSchema, validateQuizShape } from "./quiz-schema.mjs";
import { buildPrompt } from "./prompt.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.READBACK_PORT || 41739);
const DEFAULT_MODEL = process.env.READBACK_MODEL || "gpt-5.6-luna";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OPENAI_TIMEOUT_MS = 110000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function loadApiKey(envPath = resolve(ROOT, ".env.local")) {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  let source;
  try {
    source = await readFile(envPath, "utf8");
  } catch {
    return "";
  }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const raw = match[1];
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
    return raw;
  }
  return "";
}

export function normalizeRequest(body) {
  const page = body?.page || {};
  const raw = body?.settings || {};
  const settings = {
    questionCount: [3, 5, 7, 10].includes(Number(raw.questionCount)) ? Number(raw.questionCount) : 5,
    optionCount: [2, 3, 4, 5].includes(Number(raw.optionCount)) ? Number(raw.optionCount) : 4,
    level: ["recall", "explain", "apply"].includes(raw.level) ? raw.level : "apply"
  };
  return {
    page: {
      title: String(page.title || "Untitled page").slice(0, 300),
      text: String(page.text || "").slice(0, 28000),
      diagrams: Array.isArray(page.diagrams) ? page.diagrams.slice(0, 3) : [],
      images: Array.isArray(page.images) ? page.images.slice(0, 3).filter(validImage) : [],
      screenshot: validDataImage(page.screenshot) ? page.screenshot : null
    },
    settings
  };
}

function validImage(image) {
  return image && typeof image.ref === "string" && validDataImage(image.dataUrl);
}

function validDataImage(value) {
  return typeof value === "string" && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 4_500_000;
}

export function buildOpenAIRequest(input, model = DEFAULT_MODEL) {
  const media = [];
  const mediaRefs = ["none"];
  if (input.page.screenshot) {
    mediaRefs.push("page_view");
    media.push({ type: "input_image", image_url: input.page.screenshot, detail: "low" });
  }
  for (const image of input.page.images) {
    mediaRefs.push(image.ref);
    media.push({ type: "input_image", image_url: image.dataUrl, detail: "low" });
  }

  return {
    request: {
      model,
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: 7000,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: buildPrompt({ ...input, mediaRefs }) },
          ...media
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "readback_quiz",
          strict: true,
          schema: buildQuizSchema(input.settings.questionCount, input.settings.optionCount, mediaRefs)
        }
      }
    },
    mediaRefs
  };
}

export function extractOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

async function callOpenAI(input, apiKey) {
  const { request, mediaRefs } = buildOpenAIRequest(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload?.error?.code || payload?.error?.type || `http_${response.status}`;
    const message = payload?.error?.message || "OpenAI could not create the quiz.";
    const error = new Error(`${message} (${code})`);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  const outputText = extractOutputText(payload);
  if (!outputText) throw new Error("OpenAI returned no quiz content.");
  let quiz;
  try {
    quiz = JSON.parse(outputText);
  } catch {
    throw new Error("OpenAI returned a quiz that could not be read.");
  }
  const shapeError = validateQuizShape(quiz, input.settings.questionCount, input.settings.optionCount, mediaRefs);
  if (shapeError) throw new Error(shapeError);
  quiz.model = request.model;
  return quiz;
}

function corsHeaders(origin) {
  const allowed = typeof origin === "string" && /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
}

function sendJson(response, status, body, origin = "") {
  response.writeHead(status, { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("The page capture is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("The request was not valid JSON.");
    error.status = 400;
    throw error;
  }
}

export async function startServer() {
  const apiKey = await loadApiKey();
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin || "";
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(origin));
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true, keyConfigured: Boolean(apiKey), model: DEFAULT_MODEL });
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/quiz") {
      sendJson(response, 404, { error: "Not found." }, origin);
      return;
    }
    if (!/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) {
      sendJson(response, 403, { error: "Only the Readback browser extension can use this service." }, origin);
      return;
    }
    if (!apiKey) {
      sendJson(response, 503, { error: "OPENAI_API_KEY is missing from .env.local." }, origin);
      return;
    }
    try {
      const input = normalizeRequest(await readJson(request));
      if (input.page.text.length < 250) {
        sendJson(response, 400, { error: "The page does not have enough readable text for a useful quiz." }, origin);
        return;
      }
      const quiz = await callOpenAI(input, apiKey);
      sendJson(response, 200, { quiz }, origin);
    } catch (error) {
      const status = Number(error.status) || (error.name === "AbortError" ? 504 : 500);
      sendJson(response, status, { error: error.name === "AbortError" ? "OpenAI took too long to answer." : error.message }, origin);
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolvePromise);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(() => {
    process.stdout.write(`Readback is ready at http://${HOST}:${PORT}\n`);
    process.stdout.write(`Model: ${DEFAULT_MODEL} with low reasoning\n`);
    process.stdout.write("Keep this window open while you use the extension. Press Control-C to stop.\n");
  }).catch((error) => {
    process.stderr.write(`Readback could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
