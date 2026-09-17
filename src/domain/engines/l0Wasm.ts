/**
 * The Rust→WASM carrier for the L0 recurrence.
 *
 * The wasm module is a `cdylib` with no allocator, no `std` and no dependencies:
 * it renders a row of pixels into two fixed static buffers and the host reads
 * them through its own typed-array views. There is nothing to allocate, so there
 * is nothing to leak, and the module is about a kilobyte.
 *
 * It is held to the JavaScript engine by a **bit-identical** differential, not a
 * tolerance. That is achievable because the two were written to the same order of
 * operations, and it is the property that makes the speedup safe to rely on:
 * swapping the carrier cannot move a single pixel.
 *
 * The module is loaded lazily. Until it is, the JavaScript engine runs — and
 * `loadL0Engine` reports which one it returned rather than letting a caller
 * assume.
 */

import wasmUrl from "./l0.wasm?url";
import { type L0Engine, type L0RowRequest, type L0RowResult } from "./directFloat";

type L0Exports = {
  readonly memory: WebAssembly.Memory;
  iterations_ptr(): number;
  magnitudes_ptr(): number;
  max_row(): number;
  render_row(
    cRe0: number,
    cIm: number,
    dRe: number,
    count: number,
    maxIterations: number,
  ): void;
};

export type WasmEngineOptions = {
  /** How the module bytes are obtained. Defaults to `fetch` on the module URL. */
  readonly loadBytes?: () => Promise<ArrayBuffer>;
};

function wrap(exports: L0Exports): L0Engine {
  const maxRow = exports.max_row();
  const iterationBase = exports.iterations_ptr();
  const magnitudeBase = exports.magnitudes_ptr();
  if (maxRow < 1) {
    throw new Error("l0 wasm: module reports a zero row capacity");
  }

  return {
    name: "wasm-f64-simd",
    simd: true,

    renderRow(request: L0RowRequest): L0RowResult {
      if (!Number.isInteger(request.count) || request.count < 1) {
        throw new Error(
          `l0 row: count must be a positive integer (got ${request.count})`,
        );
      }
      const iterations = new Int32Array(request.count);
      const magnitudes = new Float64Array(request.count);

      // The module renders at most `maxRow` pixels per call, so a wider run is
      // split — each chunk offset by its own real-axis step.
      for (let start = 0; start < request.count; start += maxRow) {
        const chunk = Math.min(maxRow, request.count - start);
        exports.render_row(
          request.cRe0 + request.dRe * start,
          request.cIm,
          request.dRe,
          chunk,
          request.maxIterations,
        );
        // Views are taken after the call: the module never grows its memory (no
        // allocator), so these stay valid, but reading fresh is cheap and rules
        // out a stale view entirely.
        const chunkIterations = new Int32Array(
          exports.memory.buffer,
          iterationBase,
          chunk,
        );
        const chunkMagnitudes = new Float64Array(
          exports.memory.buffer,
          magnitudeBase,
          chunk,
        );
        iterations.set(chunkIterations, start);
        magnitudes.set(chunkMagnitudes, start);
      }
      return { iterations, magnitudeSquared: magnitudes };
    },
  };
}

/**
 * Load the WASM engine.
 *
 * Throws with the reason if the module cannot be fetched or instantiated — a
 * caller that asked for the fast carrier gets told it is unavailable rather than
 * silently receiving the slow one.
 */
export async function loadL0WasmEngine(
  options: WasmEngineOptions = {},
): Promise<L0Engine> {
  if (typeof WebAssembly === "undefined") {
    throw new Error("l0 wasm: this environment has no WebAssembly");
  }
  const bytes = await (options.loadBytes ?? defaultLoadBytes)();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as unknown as L0Exports;
  if (
    typeof exports.render_row !== "function" ||
    typeof exports.iterations_ptr !== "function" ||
    typeof exports.magnitudes_ptr !== "function" ||
    typeof exports.max_row !== "function" ||
    !(exports.memory instanceof WebAssembly.Memory)
  ) {
    throw new Error(
      "l0 wasm: the module does not export the expected surface (render_row, iterations_ptr, magnitudes_ptr, max_row, memory)",
    );
  }
  return wrap(exports);
}

async function defaultLoadBytes(): Promise<ArrayBuffer> {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(
      `l0 wasm: fetch failed with ${response.status} ${response.statusText}`,
    );
  }
  return await response.arrayBuffer();
}
