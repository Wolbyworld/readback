import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browser } from "./browser-harness.mjs";

// Start tests/ui-harness-server.mjs first. This uses only its fixed demo content.
const base = "http://127.0.0.1:41740";
if (!browser) throw new Error("Chrome or Chromium is required to capture previews.");
await fetch(`${base}/chrome-shim.js`).then(response => {
  if (!response.ok) throw new Error("Start the UI harness before capturing previews.");
});
const profile = await mkdtemp(join(tmpdir(), "readback-previews-"));
const child = spawn(browser, ["--headless", "--disable-gpu", "--disable-background-networking",
  "--disable-extensions", "--disable-sync", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await delay(100); }
  }
  if (!port) throw new Error("Chrome did not start.");
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width:400, height:940, deviceScaleFactor:2, mobile:false });
  for (const state of ["start", "quiz", "feedback", "results"]) {
    await command("Page.navigate", { url:`${base}/?state=${state}` });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const selector = state === "feedback" ? "#answers .is-wrong" : `#${state}Screen.is-active`;
      const result = await command("Runtime.evaluate", { expression:`Boolean(document.querySelector(${JSON.stringify(selector)}))` });
      if (result.result.value) { ready = true; break; }
    }
    if (!ready) throw new Error(`Demo state did not appear: ${state}`);
    await delay(350);
    const { data } = await command("Page.captureScreenshot", { format:"png", captureBeyondViewport:false });
    await writeFile(new URL(`../previews/${state}.png`, import.meta.url), Buffer.from(data, "base64"));
    process.stdout.write(`Captured ${state} at 400 × 940\n`);
  }
} finally {
  socket?.close();
  const closed = new Promise(resolve => child.once("close", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  await closed;
  clearTimeout(timer);
  await rm(profile, { recursive:true, force:true });
}
