#!/usr/bin/env node
/**
 * Generate the screenshot the futuremagic.de app card shows.
 *
 * The website builds the card's image URL from the app's `futuremagic.json`: a
 * relative path is resolved against the app's own directory, so the screenshot
 * lives inside this app's deploy (`/Orion/shot.png`) rather than in a shared
 * `/shots/` directory that nothing uploads. That is why the sibling project's
 * card image is a 404 and this one is not.
 *
 * It drives the real app in the browser lane's Chrome (SwiftShader), waits for a
 * finished render, and captures the display canvas at its native size.
 *
 * Usage:
 *   node scripts/make-screenshot.mjs [--url http://127.0.0.1:5199] [--out public/shot.png]
 *
 * With no `--url` it starts `vite preview` on a free port itself, so it works
 * from a clean checkout after `pnpm run build`.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const out = path.resolve(argValue("--out", "public/shot.png"));
const explicitUrl = argValue("--url", null);
const port = Number(argValue("--port", "5233"));
// The base path is read from the same variable the build uses, so a sub-path
// build is captured at the URL it will actually be served from.
const rawBase = argValue("--base", process.env.ORION_BASE?.trim() || "/");
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
const baseUrl = explicitUrl ?? `http://127.0.0.1:${port}`;
const appUrl = new URL(
  base.replace(/^\//, ""),
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
).toString();

/** The same flags the browser lane uses: this box has no GPU, only SwiftShader. */
const chromeArgs = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
];

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

let server = null;
if (explicitUrl === null) {
  server = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--port",
      String(port),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const up = await waitForServer(appUrl, 60_000);
  if (!up) {
    server.kill("SIGTERM");
    throw new Error(`vite preview did not come up on ${baseUrl}`);
  }
}

const browser = await chromium.launch({ channel: "chrome", args: chromeArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });

  // The status line fills in only once a full pass has completed, so it is the
  // signal that what we are about to capture is a finished image.
  await page.getByText(/· preview/).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);

  const canvas = page.locator("canvas:visible").first();
  if ((await canvas.count()) === 0) throw new Error("no visible canvas to capture");
  const image = await canvas.screenshot({ type: "png" });

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, image);
  const status = await page.getByText(/· preview/).innerText();
  console.log(
    `wrote ${path.relative(process.cwd(), out)} (${image.byteLength} bytes) from ${appUrl}`,
  );
  console.log(`  status: ${status.replace(/\s+/g, " ").slice(0, 200)}`);
  if (consoleErrors.length > 0) {
    // A blank or broken app would still produce a PNG, so a page error here is a
    // reason to distrust the screenshot rather than something to ignore.
    throw new Error(
      `the page raised ${consoleErrors.length} error(s): ${consoleErrors[0]}`,
    );
  }
} finally {
  await browser.close();
  if (server !== null) {
    server.kill("SIGTERM");
  }
}
