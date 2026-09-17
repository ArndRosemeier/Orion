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

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
