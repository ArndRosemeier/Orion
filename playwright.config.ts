import { defineConfig } from "playwright/test";

/**
 * The browser lane: proves the GPU kernels agree with the CPU oracle.
 *
 * It runs against the real Vite dev server and the real render backends.
 * Playwright's **managed** Chromium is driven through SwiftShader (software
 * Vulkan) — see docs/TESTING.md for the capability probe that established this
 * works for both WebGL2 and WebGPU. The browser version is pinned by the
 * `playwright` version in pnpm-lock.yaml, not by whatever Chrome the machine
 * happens to have; `bash scripts/setup-browser.sh` installs it rootless.
 *
 * Correctness only. SwiftShader is 100-1000x slower than silicon, so nothing
 * here may assert a timing.
 */
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    channel: "chromium",
    launchOptions: {
      // WebGL2 needs SwiftShader; WebGPU needs Chrome's bundled Vulkan
      // SwiftShader ICD. Both are software rasterisers, which is all this box
      // has — see the capability probe in docs/TESTING.md.
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-unsafe-swiftshader",
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-vulkan=swiftshader",
      ],
    },
  },
  webServer: {
    command: "pnpm exec vite --port 5199 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5199/harness.html",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
