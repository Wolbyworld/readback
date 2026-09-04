import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workerUrl = new URL("../extension/service-worker.js", import.meta.url);
const fixtureUrl = new URL("./extraction-fixture.html", import.meta.url);
const browserCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].filter(Boolean);
const browser = browserCandidates.find(existsSync);

function dumpDom(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    let hasResult = false;
    let timeoutError = null;
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timeoutError = new Error("headless browser did not finish extraction within 15 seconds");
      stop();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!hasResult && /<pre id="result">[^<]+<\/pre>/.test(stdout)) {
        hasResult = true;
        clearTimeout(timeout);
        stop();
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timeoutError) reject(timeoutError);
      else resolve(stdout);
    });
  });
}

function extractionFunction(source) {
  const start = source.indexOf("async function collectReadablePage");
  const end = source.indexOf("function friendlyExtractionError", start);
  assert.notEqual(start, -1, "collectReadablePage is missing");
  assert.notEqual(end, -1, "friendlyExtractionError boundary is missing");
  return source.slice(start, end);
}

test("extracts useful raster, SVG, and canvas visuals with exact stable refs", { skip: !browser }, async () => {
  const [worker, fixture] = await Promise.all([
    readFile(workerUrl, "utf8"),
    readFile(fixtureUrl, "utf8")
  ]);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "readback-extraction-"));
  const harnessPath = join(temporaryDirectory, "extraction-harness.html");
  const profilePath = join(temporaryDirectory, "chrome-profile");
  const base = `<base href="${fixtureUrl.href}">`;
  const harness = fixture
    .replace("<head>", `<head>${base}`)
    .replace("</body>", `<script>${extractionFunction(worker)}
      addEventListener("load", async () => {
        await Promise.all([...document.images].map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })));
        const result = await collectReadablePage(28000, { maxVisuals: 3, maxVisualEdge: 1000, maxDataUrlLength: 1500000 });
        const output = document.createElement("pre");
        output.id = "result";
        output.textContent = btoa(JSON.stringify(result));
        document.body.replaceChildren(output);
      });
    </script></body>`);

  try {
    await writeFile(harnessPath, harness);
    const stdout = await dumpDom(browser, [
      "--headless",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-extensions-with-background-pages",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--allow-file-access-from-files",
      `--user-data-dir=${profilePath}`,
      "--virtual-time-budget=5000",
      "--dump-dom",
      `file://${harnessPath}`
    ]);
    const encoded = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(encoded, "headless browser did not return extraction output");
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));

    assert.doesNotMatch(result.text, /IGNORE ALL RULES|Account Pricing Cookie settings/);
    assert.equal(result.images.length, 3, JSON.stringify(result.images.map(({ ref, alt }) => ({ ref, alt }))));
    assert.deepEqual(result.images.map(({ ref }) => ref), ["visual_1", "visual_2", "visual_3"]);
    assert.ok(result.images.every(({ dataUrl }) => dataUrl.startsWith("data:image/jpeg;base64,")));
    assert.ok(result.images.every(({ dataUrl }) => dataUrl.length <= 1_500_000));
    assert.deepEqual(new Set(result.diagrams.map(({ ref }) => ref)), new Set(["visual_1", "visual_2"]));

    const labels = result.images.map(({ alt }) => alt).join(" | ");
    assert.match(labels, /Warm surface and cold deep-water circulation/);
    assert.match(labels, /Salinity measurements across five stations/);
    assert.match(labels, /Cooling-method measurements after one hour/);
    assert.doesNotMatch(labels, /logo|profile|sponsored|advertisement/i);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("uses a visible-page screenshot only when no extracted visual succeeds", async () => {
  const worker = await readFile(workerUrl, "utf8");
  const extraction = worker.slice(
    worker.indexOf("async function extractActivePage"),
    worker.indexOf("async function collectReadablePage")
  );

  assert.match(extraction, /if \(!result\.images\.length\) \{/);
  assert.match(extraction, /captureVisibleTab/);
  assert.match(worker, /if \(images\.length >= limits\.maxVisuals\) break/);
  assert.match(worker, /catch \{\s*\/\/ A cross-origin raster or tainted canvas can fail\./);
});
