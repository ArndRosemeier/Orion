import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Cross-origin isolation is required for `SharedArrayBuffer`, which the CPU
 * worker pool uses to hand tiles back without a structured-clone copy. A static
 * host must send the same two headers, or the pool reports `transport:
 * "transfer"` instead of quietly behaving differently — see docs/TESTING.md.
 */
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * Sub-path support for the static deploy.
 *
 * `https://futuremagic.de/Orion/` serves the app from a directory, so every asset
 * URL has to be prefixed. The base comes from `ORION_BASE` when set (the deploy
 * script sets it to `/Orion/`) and defaults to `/` for a root deploy and for the
 * browser test lane, which serves the app at `/`.
 */
export default defineConfig(({ mode }) => {
  const fromEnv = process.env.ORION_BASE?.trim();
  const base =
    fromEnv && fromEnv.length > 0
      ? fromEnv.endsWith("/")
        ? fromEnv
        : `${fromEnv}/`
      : mode === "domainfactory"
        ? "/Orion/"
        : "/";

  return {
    base,
    plugins: [react()],
    server: { headers: crossOriginIsolation },
    preview: { headers: crossOriginIsolation },
    test: {
      globals: true,
      environment: "node",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  };
});
