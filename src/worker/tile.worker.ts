/**
 * The tile worker.
 *
 * It renders one tile at a time with the *same* CPU backend the main thread
 * uses — not a copy, not a reimplementation — so a tile rendered here is
 * bit-identical to one rendered serially. That is the whole correctness claim of
 * the pool, and it is checked by a differential against the serial path.
 *
 * Two things cross the boundary that are worth noting:
 *  - the view arrives as a URL fragment and is decoded with the shareable-link
 *    codec, so there is one definition of what a view is;
 *  - the reply is validated by a schema on the way out *and* on the way in, so a
 *    worker that returns nonsense is caught rather than trusted.
 */

import { makePalette } from "../domain/color/palette";
import { makeTileResult } from "../domain/render/backend";
import { loadL0WasmEngine } from "../domain/engines/l0Wasm";
import type { BlaTable } from "../domain/engines/bla";
import type { SeriesApproximation } from "../domain/engines/series";
import type { ConvergedOrbit } from "../domain/engines/reference";
import {
  loadPerturbWasmEngine,
  type PerturbWasmEngine,
} from "../domain/engines/perturbWasm";
import { jsDeltaCarrier, type DeltaCarrier } from "../domain/engines/perturbation";
import { createJsL0Engine, type L0Engine } from "../domain/engines/directFloat";
import { createCpuBackend } from "../domain/render/cpu";
import { createLruCache } from "../domain/render/tiles";
import {
  type WorkItem,
  type WorkResult,
  WorkItemSchema,
} from "../domain/render/workerProtocol";
import { decodeView } from "../domain/view/url";

/**
 * The worker global, typed narrowly.
 *
 * The project's `lib` is DOM (the app's target), where `self` is a `Window` and
 * `postMessage` has the window overload. Rather than adding `WebWorker` to the
 * lib — which collides with DOM on `self` — the worker declares exactly the two
 * members it uses.
 */
type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

const scope = self as unknown as WorkerScope;

/**
 * The L0 carrier, chosen once per worker.
 *
 * The WASM engine is tried first and the JavaScript one is the fallback — but
 * the fallback is *visible*: the CPU backend reports the carrier it used in the
 * tile's stage string, and the browser lane asserts the WASM one. A silent
 * degradation to the slower carrier would fail that test rather than quietly
 * halving throughput.
 */
let engine: L0Engine = createJsL0Engine();
let perturb: DeltaCarrier = jsDeltaCarrier;
let blaCarrierFactory: ((table: BlaTable) => DeltaCarrier) | null = null;

/**
 * The per-view caches, held by the worker for its lifetime.
 *
 * Without these every tile of a view recomputes the reference orbit, the series
 * coefficients and the BLA table — work that is per *view*, not per tile. They
 * are bounded, so a worker that sees many views does not grow without limit.
 */
const caches = {
  orbitCache: createLruCache<string, ConvergedOrbit>(8),
  seriesCache: createLruCache<string, SeriesApproximation>(8),
  blaCache: createLruCache<string, BlaTable>(8),
};

let backend = createCpuBackend({
  l0: engine,
  perturbCarrier: perturb,
  wasmBlaCarrier: blaCarrierFactory,
  ...caches,
});
const engineReady = Promise.all([
  loadL0WasmEngine()
    .then((wasm) => {
      engine = wasm;
    })
    .catch(() => {
      // Left on the JavaScript engine; the stage string reports which ran.
    }),
  loadPerturbWasmEngine()
    .then((wasm: PerturbWasmEngine) => {
      perturb = wasm;
      blaCarrierFactory = (table) => wasm.blaCarrier(table);
    })
    .catch(() => {
      // Same: the stage string says which carrier iterated the deltas.
    }),
]).then(() => {
  backend = createCpuBackend({
    l0: engine,
    perturbCarrier: perturb,
    wasmBlaCarrier: blaCarrierFactory,
    ...caches,
  });
});

async function handle(
  item: WorkItem,
): Promise<{ result: WorkResult; transfer: Transferable[] }> {
  // Wait for the carrier decision before rendering, so a tile cannot be produced
  // by one engine and reported as another.
  await engineReady;
  const view = decodeView(item.viewFragment).view;
  const palette = makePalette(item.palette.name, item.palette.stops, {
    size: item.palette.size,
    cyclesPerUnit: item.palette.cyclesPerUnit,
  });
  const columns = Math.ceil(item.tile.width / item.step);
  const rows = Math.ceil(item.tile.height / item.step);
  const tileResult = makeTileResult(columns, rows, item.output);

  await backend.render(
    {
      view,
      tile: item.tile,
      step: item.step,
      quality: item.quality,
      maxIterations: item.maxIterations,
      palette,
      output: item.output,
    },
    tileResult,
  );

  const target = item.target;
  if (target !== null && item.output === "colour") {
    // Write straight into the shared image: no copy, no clone, no reply buffer.
    //
    // The view covers the rectangle's *actual* extent — the last row is only
    // `columns` wide, not `stride` — because the target is now a rectangle
    // inside a larger pass image. Sizing it as `rows * stride` was correct only
    // while every target was a tile-sized scratch buffer starting at offset 0,
    // and overran the buffer for a rectangle near the image's right edge.
    const extent = (rows - 1) * target.stride + columns * 4;
    const destination = new Uint8ClampedArray(target.buffer, target.byteOffset, extent);
    for (let row = 0; row < rows; row++) {
      const source = row * columns * 4;
      destination.set(
        tileResult.pixels.subarray(source, source + columns * 4),
        row * target.stride,
      );
    }
    return {
      result: {
        id: item.id,
        ok: true,
        stage: tileResult.stage,
        pixels: null,
        escapeCounts: null,
        width: columns,
        height: rows,
      },
      transfer: [],
    };
  }

  const pixels = item.output === "colour" ? exactBuffer(tileResult.pixels) : null;
  const counts =
    item.output === "escape-count" ? exactBuffer(tileResult.escapeCounts) : null;
  const transfer: Transferable[] = [];
  if (pixels) transfer.push(pixels);
  if (counts) transfer.push(counts);
  return {
    result: {
      id: item.id,
      ok: true,
      stage: tileResult.stage,
      pixels,
      escapeCounts: counts,
      width: columns,
      height: rows,
    },
    transfer,
  };
}

/** A standalone ArrayBuffer, so it can be transferred rather than copied. */
function exactBuffer(view: Uint8ClampedArray | Float32Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
  );
  return copy;
}

scope.onmessage = (event: MessageEvent) => {
  const parsed = WorkItemSchema.safeParse(event.data);
  if (!parsed.success) {
    // A malformed work item cannot be attributed to a request id, so it is
    // reported with id -1 and the pool treats it as a fatal protocol error.
    const failure: WorkResult = {
      id: -1,
      ok: false,
      error: `worker: invalid work item (${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")})`,
    };
    scope.postMessage(failure);
    return;
  }
  void handle(parsed.data)
    .then(({ result, transfer }) => scope.postMessage(result, transfer))
    .catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure: WorkResult = { id: parsed.data.id, ok: false, error: message };
      scope.postMessage(failure);
    });
};
