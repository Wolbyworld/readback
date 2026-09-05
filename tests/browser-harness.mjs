import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const browser = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
  "/usr/bin/google-chrome", "/usr/bin/chromium"
].filter(Boolean).find(existsSync);

export async function runBrowserHarness(html) {
  const directory = await mkdtemp(join(tmpdir(), "readback-evidence-"));
  try {
    const file = join(directory, "test.html");
    await writeFile(file, html);
    return await new Promise((resolve, reject) => {
      const child = spawn(browser, ["--headless", "--disable-gpu", "--disable-background-networking",
        "--disable-extensions", "--disable-sync", "--no-first-run", "--no-default-browser-check",
        "--allow-file-access-from-files", `--user-data-dir=${join(directory, "profile")}`,
        "--virtual-time-budget=5000", "--dump-dom", `file://${file}`], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (/<pre id="test-result">[^<]+<\/pre>/.test(output)) {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 1000).unref();
        }
      });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", () => {
        clearTimeout(timer);
        const encoded = output.match(/<pre id="test-result">([^<]+)<\/pre>/)?.[1];
        if (!encoded) return reject(new Error("Browser did not return test results"));
        resolve(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const reportResult = `
  const output = document.createElement("pre");
  output.id = "test-result";
  output.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(results))));
  document.body.append(output);
`;
