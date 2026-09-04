import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildOpenAIRequest, createQuizWithOpenAI, extractOutputText, normalizeRequest } from "../extension/openai-request.js";

export { buildOpenAIRequest, extractOutputText, normalizeRequest };

const HOST = "127.0.0.1";
const PORT = Number(process.env.READBACK_PORT || 41739);
const DEFAULT_MODEL = process.env.READBACK_MODEL || "gpt-5.6-luna";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
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

async function callOpenAI(input, apiKey) {
  return createQuizWithOpenAI(input, apiKey, { model: DEFAULT_MODEL });
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
    process.stdout.write(`Model: ${DEFAULT_MODEL}; adaptive reasoning by quiz depth\n`);
    process.stdout.write("Keep this window open while you use the extension. Press Control-C to stop.\n");
  }).catch((error) => {
    process.stderr.write(`Readback could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
