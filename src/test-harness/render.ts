/**
 * Browser test harness.
 *
 * A headless page that exposes the render backends to Playwright, so GPU output
 * can be compared against the CPU oracle as *numbers* rather than as colours.
 * It lives under `src/` so the ordinary typecheck covers it, and it is not part
 * of the app: `harness.html` is a separate Vite entry that only the browser lane
 * loads.
 *
 * The harness deliberately re-uses the production backends and the production
 * view construction. A harness that built its own view would be testing a
 * different program. Both GPU backends are reachable by name, which is what lets
 * one differential test judge them against the same reference.
 */

import { CLASSIC_PALETTE } from "../domain/color/palette";
import { createJsL0Engine, type L0RowResult } from "../domain/engines/directFloat";
import { loadPerturbWasmEngine } from "../domain/engines/perturbWasm";
import {
  type DeltaRequest,
  type PerturbationResult,
  jsDeltaCarrier,
} from "../domain/engines/perturbation";
import { buildBla, createBlaCarrier } from "../domain/engines/bla";
import { viewDiagonalMagnitude } from "../domain/render/cpu";
import { computeConvergedReferenceOrbit } from "../domain/engines/reference";
import {
  allocateFloatComplexArray,
  writeFloatComplex,
} from "../domain/numeric/floatexparray";
import { floatComplex } from "../domain/numeric/floatcomplex";
import { fromBigFixed } from "../domain/numeric/floatexp";
import { withFracBits } from "../domain/numeric/bigfixed";
import { loadL0WasmEngine } from "../domain/engines/l0Wasm";
import { planView } from "../domain/ladder/plan";
import { bigComplex } from "../domain/numeric/bigcomplex";
import {
  add,
  fromDecimal,
  fromInt,
  mul,
  toDecimalString,
} from "../domain/numeric/bigfixed";
import { type FractalBackend, makeTileResult } from "../domain/render/backend";
import { createWebGl2Backend } from "../domain/render/webgl2";
import { createWebGpuBackend } from "../domain/render/webgpu";
import { createCpuBackend } from "../domain/render/cpu";
import { createLruCache, createTileCache } from "../domain/render/tiles";
import { createWorkerPool } from "../domain/render/workerPool";
import { renderView } from "../domain/render/scheduler";
import { passesFor } from "../domain/render/passes";
import {
  clearMeasurements,
  measurementFor,
  viewMeasurementKey,
} from "../domain/ladder/measurements";
import {
  makeView,
  pixelSizeOf,
  pixelToComplex,
  scaleExponentOf,
} from "../domain/view/view";
import { shiftInUlps, viewFromDoubles, zoomAtPixel } from "../domain/view/navigate";
import { decodeView, encodeView } from "../domain/view/url";

export type HarnessBackendName = "webgl2" | "webgpu" | "cpu" | "cpu-pool";

export type HarnessQuality = "preview" | "exact";

export type HarnessViewConfig = {
  /** Decimal strings, so full precision crosses the boundary intact. */
  readonly centerRe: string;
  readonly centerIm: string;
  readonly width: string;
  readonly fracBits: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly maxIterations: number;
};

export type HarnessCounts = {
  readonly counts: number[];
  readonly stage: string;
};

export type HarnessCapability = {
  readonly supported: boolean;
  readonly why: string;
};

export type HarnessPoolInfo = {
  readonly size: number;
  readonly transport: string;
  readonly isolated: boolean;
  readonly stats: { dispatched: number; completed: number; failed: number };
};

export type L0Benchmark = {
  readonly jsName: string;
  readonly wasmName: string;
  readonly jsMs: number;
  readonly wasmMs: number;
  readonly speedup: number;
  readonly mismatches: number;
  readonly compared: number;
};

export type SeriesBenchmark = {
  readonly exactMs: number;
  readonly previewMs: number;
  readonly speedup: number;
  readonly exactStage: string;
  readonly previewStage: string;
  /** Sum of the reported escape counts, so "fast" can be told from "did nothing". */
  readonly exactChecksum: number;
  readonly previewChecksum: number;
  readonly interiorPixels: number;
  readonly pixels: number;
};

export type TileReuseReport = {
  /** Warm render identical to a cold render of the same panned view. */
  readonly identical: boolean;
  readonly firstSkipped: number;
  readonly warmSkipped: number;
  readonly warmTiles: number;
  readonly coldTiles: number;
  readonly hits: number;
  readonly stage: string;
};

export type DeepNavigationReport = {
  /** `log2` of the final pixel spacing — the zoom depth, negative. */
  readonly scaleExponent: number;
  readonly fracBits: number;
  /** Stage the ladder picks for the app's quality, and for exact. */
  readonly stagePreview: string;
  readonly stageExact: string;
  /** Whether the direct f64 stage is still valid at this depth, and why not. */
  readonly directValid: boolean;
  readonly directWhy: string;
  readonly urlLength: number;
  /** The link the app would write decodes back to the identical view. */
  readonly roundTrips: boolean;
  readonly anchorDriftUlps: number;
  /** The anchored point's drift in *pixels* — the unit a user can judge. */
  readonly anchorDriftPixels: number;
  readonly widthDigits: number;
};

/** A synthetic perturbation scenario, expressed as plain data. */
export type PerturbScenario = {
  /** Orbit entries as `[mantissa, exponent]` pairs, index 0 first. */
  readonly orbit: readonly (readonly [number, number])[];
  readonly requests: readonly {
    readonly dcRe: readonly [number, number];
    readonly dcIm: readonly [number, number];
    readonly startRe: readonly [number, number];
    readonly startIm: readonly [number, number];
    readonly startIteration: number;
  }[];
  readonly maxIterations: number;
};

export type PerturbDifferential = {
  readonly identical: boolean;
  readonly mismatches: readonly number[];
  readonly js: readonly PerturbationResult[];
  readonly wasm: readonly PerturbationResult[];
  readonly jsCarrier: string;
  readonly wasmCarrier: string;
  readonly jsMs: number;
  readonly wasmMs: number;
};

export type PerturbBenchmark = {
  readonly pixels: number;
  readonly iterations: number;
  readonly orbitLength: number;
  readonly orbitFracBits: number;
  readonly identical: boolean;
  readonly mismatches: readonly number[];
  readonly jsMs: number;
  readonly wasmMs: number;
  readonly speedup: number;
  readonly stage: string;
  readonly carrier: string;
};

export type BlaCarrierBenchmark = {
  readonly pixels: number;
  readonly iterations: number;
  readonly blockExponent: number;
  readonly orbitLength: number;
  readonly identical: boolean;
  readonly mismatches: readonly number[];
  readonly jsMs: number;
  readonly wasmMs: number;
  readonly speedup: number;
  readonly jsEscaped: number;
  readonly wasmEscaped: number;
  /** Pixels whose escaping block was re-iterated, per carrier. */
  readonly jsRefined: number;
  readonly wasmRefined: number;
};

export type PooledColourReport = {
  readonly rgba: number[];
  /** Tiles the worker wrote straight into the pass image. */
  readonly tilesDirect: number;
  readonly tilesRendered: number;
  /** Whether the pass image itself was allocated in shared memory. */
  readonly isolated: boolean;
  readonly pool: HarnessPoolInfo;
};

export type MeasurementReport = {
  readonly stageBefore: string;
  readonly stageAfter: string;
  readonly measuredSkip: number | null;
  readonly workBefore: number;
  readonly workAfter: number;
  readonly stage: string;
};

export type OrionHarness = {
  /**
   * Plan a view, render it once through the CPU backend so it measures what it
   * validated, then plan it again — the loop the app runs between its coarse and
   * full passes.
   */
  measureAndReplan(config: HarnessViewConfig): Promise<MeasurementReport>;
  /** Renders a colour view through the pool and reports the zero-copy path. */
  renderColoursWithPool(
    config: HarnessViewConfig,
    concurrency: number,
  ): Promise<PooledColourReport>;
  /**
   * Compare the two BLA carriers — JavaScript jumps against the WASM kernel
   * applying the same tables — and time both.
   */
  benchmarkBlaCarriers(
    config: HarnessViewConfig,
    repeats: number,
  ): Promise<BlaCarrierBenchmark>;
  /**
   * Run the same delta requests through both carriers and report whether they
   * agree bit for bit, plus how long each took.
   */
  runPerturbationDifferential(
    scenario: PerturbScenario,
    repeats: number,
  ): Promise<PerturbDifferential>;
  /**
   * Time both carriers over a real deep view's orbit and pixel offsets, and
   * confirm they agree. This is the measurement the landing rests on: CPU work
   * is the one thing this box can time honestly.
   */
  benchmarkPerturbation(
    config: HarnessViewConfig,
    repeats: number,
  ): Promise<PerturbBenchmark>;
  /**
   * Zooms `steps` times on an off-centre anchor, in fixed point, and reports
   * what the navigation and the ladder did at the resulting depth.
   *
   * This is the browser-lane proof that the app's own navigation code reaches
   * depths a double cannot express.
   */
  navigateDeep(
    config: HarnessViewConfig,
    steps: number,
    factor: number,
  ): DeepNavigationReport;
  /**
   * Renders a view, pans it by a non-tile-multiple, and renders the panned view
   * twice: once with a cold cache and once warmed by the first render. Reports
   * whether the warm image is bit-identical to the cold one, and how much was
   * reused.
   */
  tileCacheReuse(
    config: HarnessViewConfig,
    panPixels: number,
    quality: HarnessQuality,
  ): Promise<TileReuseReport>;
  /**
   * Renders one deep view both ways, through the CPU backend, and reports what
   * the series accelerator bought. CPU work is timable here, unlike the GPU.
   */
  benchmarkSeriesQuality(
    config: HarnessViewConfig,
    repeats: number,
  ): Promise<SeriesBenchmark>;
  /**
   * Times the deep-zoom choices against each other on one view: exact through
   * the JavaScript carrier (the reference), exact through the WASM kernel, and
   * preview (series + BLA), which is what the app renders. Reports the stage of
   * each so the accelerators that ran are named rather than assumed.
   */
  benchmarkBla(
    config: HarnessViewConfig,
    repeats: number,
  ): Promise<{
    readonly exactJsMs: number;
    readonly exactWasmMs: number;
    readonly previewMs: number;
    readonly exactJsStage: string;
    readonly exactWasmStage: string;
    readonly previewStage: string;
    readonly pixels: number;
    readonly iterations: number;
    /** Counts from `exact` JS vs preview: how many pixels differ, and by how much. */
    readonly differing: number;
    readonly worstShift: number;
  }>;
  /**
   * Runs both L0 carriers over the same rows and reports whether they agree
   * bit for bit, plus how long each took. CPU work is the one thing this box can
   * time honestly — unlike the GPU, where SwiftShader makes timings meaningless.
   */
  benchmarkL0(
    pixels: number,
    maxIterations: number,
    repeats: number,
  ): Promise<L0Benchmark>;
  /** The stage a pooled render reported, so the L0 carrier is observable. */
  renderStageFromPool(config: HarnessViewConfig): Promise<string>;
  /** Proves a disposed pool refuses work instead of silently doing nothing. */
  poolAfterDispose(config: HarnessViewConfig): Promise<string>;
  /** As `renderWithPool`, with the pass tiling chosen by the caller. */
  renderWithPoolSized(
    config: HarnessViewConfig,
    concurrency: number,
    samplesAcross: number,
  ): Promise<{
    pool: HarnessPoolInfo;
    outcomeStages: string[];
  }>;
  /** Renders one tile through the worker pool and reports what the pool used. */
  renderWithPool(
    config: HarnessViewConfig,
    concurrency: number,
  ): Promise<{
    counts: number[];
    stages: string[];
    /** The engine stages actually used, e.g. `perturbation+series-wasm`. */
    outcomeStages: string[];
    pool: HarnessPoolInfo;
  }>;
  renderEscapeCounts(
    config: HarnessViewConfig,
    backend: HarnessBackendName,
    quality: HarnessQuality,
  ): Promise<HarnessCounts>;
  renderColours(
    config: HarnessViewConfig,
    backend: HarnessBackendName,
    quality: HarnessQuality,
  ): Promise<{ rgba: number[]; stage: string }>;
  capability(
    config: HarnessViewConfig,
    backend: HarnessBackendName,
    quality: HarnessQuality,
  ): HarnessCapability;
  scaleExponent(config: HarnessViewConfig): number;
};

function buildView(config: HarnessViewConfig) {
  return makeView(
    bigComplex(
      fromDecimal(config.centerRe, config.fracBits),
      fromDecimal(config.centerIm, config.fracBits),
    ),
    fromDecimal(config.width, config.fracBits),
    config.pixelWidth,
    config.pixelHeight,
  );
}

function buildPlan(
  view: ReturnType<typeof buildView>,
  config: HarnessViewConfig,
  quality: HarnessQuality,
) {
  return planView({
    scaleExponent: scaleExponentOf(view),
    maxIterations: config.maxIterations,
    pixelCount: view.pixelWidth * view.pixelHeight,
    quality,
  });
}

/** The same view shifted by a whole number of pixels, so the scale is unchanged. */
function panView(view: ReturnType<typeof buildView>, pixels: number) {
  const pixelSize = pixelSizeOf(view);
  return makeView(
    bigComplex(
      add(view.center.re, mul(fromInt(pixels, view.width.fracBits), pixelSize)),
      view.center.im,
    ),
    view.width,
    view.pixelWidth,
    view.pixelHeight,
  );
}

function sameImage(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** The pool's observability shape, assembled in one place. */
function poolInfo(pool: ReturnType<typeof createWorkerPool>): HarnessPoolInfo {
  const stats = pool.stats();
  return {
    size: stats.size,
    transport: stats.transport,
    isolated:
      typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true,
    stats: {
      dispatched: stats.dispatched,
      completed: stats.completed,
      failed: stats.failed,
    },
  };
}

/** The WASM perturbation kernel, loaded once per page. */
let perturbEnginePromise: Promise<
  Awaited<ReturnType<typeof loadPerturbWasmEngine>>
> | null = null;

function perturbEngine() {
  perturbEnginePromise ??= loadPerturbWasmEngine();
  return perturbEnginePromise;
}

function sameResults(
  a: readonly PerturbationResult[],
  b: readonly PerturbationResult[],
): number[] {
  const mismatches: number[] = [];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];
    if (JSON.stringify(left) !== JSON.stringify(right)) mismatches.push(index);
  }
  return mismatches;
}

function install(canvas: HTMLCanvasElement): void {
  clearMeasurements();
  const backends = new Map<HarnessBackendName, FractalBackend>();
  const backendFor = (name: HarnessBackendName): FractalBackend => {
    const existing = backends.get(name);
    if (existing) return existing;
    const created =
      name === "webgl2"
        ? createWebGl2Backend(canvas)
        : name === "webgpu"
          ? createWebGpuBackend()
          : createCpuBackend();
    backends.set(name, created);
    return created;
  };

  const api: OrionHarness = {
    async measureAndReplan(config) {
      const view = buildView(config);
      const scaleExponent = scaleExponentOf(view);
      const request = {
        scaleExponent,
        maxIterations: config.maxIterations,
        pixelCount: view.pixelWidth * view.pixelHeight,
        quality: "preview" as const,
      };
      const before = planView(request);

      const backend = createCpuBackend({
        orbitCache: createLruCache(4),
        seriesCache: createLruCache(4),
        blaCache: createLruCache(4),
      });
      const tile = { x: 0, y: 0, width: view.pixelWidth, height: view.pixelHeight };
      const result = makeTileResult(tile.width, tile.height, "escape-count");
      await backend.render(
        {
          view,
          tile,
          step: 1,
          quality: "preview",
          maxIterations: config.maxIterations,
          palette: CLASSIC_PALETTE,
          output: "escape-count",
        },
        result,
      );

      const measured = measurementFor(viewMeasurementKey(view, config.maxIterations));
      const after = planView({
        ...request,
        measuredSeriesSkip: measured?.seriesSkip ?? 0,
      });
      return {
        stageBefore: before.stage,
        stageAfter: after.stage,
        measuredSkip: measured?.seriesSkip ?? null,
        workBefore: before.estimatedWork,
        workAfter: after.estimatedWork,
        stage: result.stage,
      };
    },

    async renderColoursWithPool(config, concurrency) {
      const view = buildView(config);
      const pool = createWorkerPool({ size: concurrency });
      try {
        const outcome = await renderView({
          backend: pool,
          view,
          maxIterations: config.maxIterations,
          palette: CLASSIC_PALETTE,
          quality: "preview",
          // No tile cache: the uncached path can hand each tile the pass image
          // itself as its destination, which is the copy-free case.
          passes: passesFor(
            "pool",
            config.pixelWidth,
            config.pixelHeight,
            concurrency,
          ).filter((pass) => pass.step === 1),
          concurrency,
        });
        const image = outcome.passes[0];
        if (!image) throw new Error("renderColoursWithPool: no pass");
        return {
          rgba: Array.from(image.pixels),
          tilesDirect: outcome.tilesDirect,
          tilesRendered: outcome.tilesRendered,
          isolated:
            typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true,
          pool: poolInfo(pool),
        };
      } finally {
        pool.dispose();
      }
    },

    async runPerturbationDifferential(scenario, repeats) {
      const engine = await perturbEngine();
      const orbit = allocateFloatComplexArray(scenario.orbit.length);
      scenario.orbit.forEach(([m, e], index) => {
        writeFloatComplex(orbit, index, floatComplex({ m, e }, { m: 0, e: 0 }));
      });
      const reference = {
        ...orbit,
        center: bigComplex({ v: 0n, fracBits: 64 }, { v: 0n, fracBits: 64 }),
        fracBits: 64,
        escapedAt: null,
      };
      const requests: DeltaRequest[] = scenario.requests.map((entry) => ({
        dc: floatComplex(
          { m: entry.dcRe[0], e: entry.dcRe[1] },
          { m: entry.dcIm[0], e: entry.dcIm[1] },
        ),
        start: floatComplex(
          { m: entry.startRe[0], e: entry.startRe[1] },
          { m: entry.startIm[0], e: entry.startIm[1] },
        ),
        startIteration: entry.startIteration,
      }));

      let js: PerturbationResult[] = [];
      let wasm: PerturbationResult[] = [];
      let jsMs = 0;
      let wasmMs = 0;
      for (let repeat = 0; repeat < Math.max(1, repeats); repeat++) {
        const jsStart = performance.now();
        js = jsDeltaCarrier.iterate(reference, requests, scenario.maxIterations);
        jsMs += performance.now() - jsStart;
        const wasmStart = performance.now();
        wasm = engine.iterate(reference, requests, scenario.maxIterations);
        wasmMs += performance.now() - wasmStart;
      }
      const mismatches = sameResults(js, wasm);
      return {
        identical: mismatches.length === 0,
        mismatches,
        js,
        wasm,
        jsCarrier: jsDeltaCarrier.name,
        wasmCarrier: engine.name,
        jsMs,
        wasmMs,
      };
    },

    async benchmarkPerturbation(config, repeats) {
      const engine = await perturbEngine();
      const view = buildView(config);
      const plan = buildPlan(view, config, "exact");
      const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
      const orbit = computeConvergedReferenceOrbit(
        reference,
        config.maxIterations + 1,
        view.width.fracBits,
      ).orbit;
      const bits = orbit.fracBits;
      const requests: DeltaRequest[] = [];
      for (let y = 0; y < config.pixelHeight; y++) {
        for (let x = 0; x < config.pixelWidth; x++) {
          const c = pixelToComplex(view, x, y);
          const offset = bigComplex(
            {
              v: withFracBits(c.re, bits).v - withFracBits(orbit.center.re, bits).v,
              fracBits: bits,
            },
            {
              v: withFracBits(c.im, bits).v - withFracBits(orbit.center.im, bits).v,
              fracBits: bits,
            },
          );
          const dc = floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im));
          requests.push({ dc, start: dc, startIteration: 1 });
        }
      }

      let js: PerturbationResult[] = [];
      let wasm: PerturbationResult[] = [];
      let jsMs = 0;
      let wasmMs = 0;
      for (let repeat = 0; repeat < Math.max(1, repeats); repeat++) {
        const jsStart = performance.now();
        js = jsDeltaCarrier.iterate(orbit, requests, config.maxIterations);
        jsMs += performance.now() - jsStart;
        const wasmStart = performance.now();
        wasm = engine.iterate(orbit, requests, config.maxIterations);
        wasmMs += performance.now() - wasmStart;
      }
      const mismatches = sameResults(js, wasm);
      return {
        pixels: requests.length,
        iterations: config.maxIterations,
        orbitLength: orbit.length,
        orbitFracBits: orbit.fracBits,
        identical: mismatches.length === 0,
        mismatches,
        jsMs,
        wasmMs,
        speedup: wasmMs > 0 ? jsMs / wasmMs : 0,
        stage: plan.stage,
        carrier: engine.name,
      };
    },

    navigateDeep(config, steps, factor) {
      let view = viewFromDoubles(
        Number(config.centerRe),
        Number(config.centerIm),
        Number(config.width),
        config.pixelWidth,
        config.pixelHeight,
      );
      // Deliberately off-centre: a centre anchor would keep the centre fixed
      // whatever the code did, and would prove nothing.
      const px = config.pixelWidth / 3;
      const py = config.pixelHeight / 3;
      const anchor = pixelToComplex(view, px, py);
      for (let step = 0; step < steps; step++) {
        view = zoomAtPixel(view, px, py, factor);
      }
      const now = pixelToComplex(view, px, py);
      const depth = scaleExponentOf(view);
      const full = planView({
        scaleExponent: depth,
        maxIterations: config.maxIterations,
        pixelCount: config.pixelWidth * config.pixelHeight,
        quality: "preview",
      });
      const direct = full.options.find((option) => option.stage === "direct-f64");
      if (!direct) throw new Error("navigateDeep: the ladder has no direct stage");
      const plan = (quality: HarnessQuality) =>
        planView({
          scaleExponent: depth,
          maxIterations: config.maxIterations,
          pixelCount: config.pixelWidth * config.pixelHeight,
          quality,
        }).stage;
      const encoded = encodeView(view, config.maxIterations);
      const decoded = decodeView(encoded);
      const driftUlps = shiftInUlps(anchor, now, view.width.fracBits);
      return {
        scaleExponent: depth,
        fracBits: view.width.fracBits,
        stagePreview: plan("preview"),
        stageExact: plan("exact"),
        directValid: direct.valid,
        directWhy: direct.why,
        urlLength: encoded.length,
        roundTrips:
          decoded.view.center.re.v === view.center.re.v &&
          decoded.view.center.im.v === view.center.im.v &&
          decoded.view.width.v === view.width.v &&
          decoded.view.width.fracBits === view.width.fracBits,
        anchorDriftUlps: driftUlps,
        anchorDriftPixels: driftUlps * 2 ** (depth - view.width.fracBits),
        widthDigits: toDecimalString(view.width).length,
      };
    },

    async tileCacheReuse(config, panPixels, quality) {
      const passes = [{ name: "full", step: 1, samplesAcross: 8 }];
      const cache = createTileCache(256);
      const original = buildView(config);
      const first = await renderView({
        backend: backendFor("cpu"),
        view: original,
        maxIterations: config.maxIterations,
        palette: CLASSIC_PALETTE,
        quality,
        passes,
        tileCache: cache,
      });
      const panned = panView(original, panPixels);
      const cold = await renderView({
        backend: backendFor("cpu"),
        view: panned,
        maxIterations: config.maxIterations,
        palette: CLASSIC_PALETTE,
        quality,
        passes,
        tileCache: createTileCache(256),
      });
      const hitsBefore = cache.stats().hits;
      const warm = await renderView({
        backend: backendFor("cpu"),
        view: panned,
        maxIterations: config.maxIterations,
        palette: CLASSIC_PALETTE,
        quality,
        passes,
        tileCache: cache,
      });
      const coldImage = cold.passes[0];
      const warmImage = warm.passes[0];
      if (!coldImage || !warmImage) throw new Error("tile cache reuse: missing pass");
      return {
        identical: sameImage(coldImage.pixels, warmImage.pixels),
        firstSkipped: first.tilesSkipped,
        warmSkipped: warm.tilesSkipped,
        warmTiles: warm.tilesRendered,
        coldTiles: cold.tilesRendered,
        hits: cache.stats().hits - hitsBefore,
        stage: warm.passes.map((pass) => pass.name).join("/"),
      };
    },

    async renderEscapeCounts(config, backendName, quality) {
      const view = buildView(config);
      const tile = { x: 0, y: 0, width: view.pixelWidth, height: view.pixelHeight };
      const result = makeTileResult(tile.width, tile.height, "escape-count");
      await backendFor(backendName).render(
        {
          view,
          tile,
          step: 1,
          quality,
          maxIterations: config.maxIterations,
          palette: CLASSIC_PALETTE,
          output: "escape-count",
        },
        result,
      );
      return { counts: Array.from(result.escapeCounts), stage: result.stage };
    },

    async renderColours(config, backendName, quality) {
      const view = buildView(config);
      const tile = { x: 0, y: 0, width: view.pixelWidth, height: view.pixelHeight };
      const result = makeTileResult(tile.width, tile.height, "colour");
      await backendFor(backendName).render(
        {
          view,
          tile,
          step: 1,
          quality,
          maxIterations: config.maxIterations,
          palette: CLASSIC_PALETTE,
          output: "colour",
        },
        result,
      );
      return { rgba: Array.from(result.pixels), stage: result.stage };
    },

    capability(config, backendName, quality) {
      const view = buildView(config);
      return backendFor(backendName).capability(view, buildPlan(view, config, quality));
    },

    async benchmarkSeriesQuality(config, repeats) {
      const view = buildView(config);
      const tile = { x: 0, y: 0, width: view.pixelWidth, height: view.pixelHeight };
      const run = async (quality: "preview" | "exact") => {
        const backend = createCpuBackend({
          orbitCache: createLruCache(4),
          seriesCache: createLruCache(4),
        });
        let stage = "";
        let checksum = 0;
        let interior = 0;
        const started = performance.now();
        for (let i = 0; i < repeats; i++) {
          const result = makeTileResult(tile.width, tile.height, "escape-count");
          await backend.render(
            {
              view,
              tile,
              step: 1,
              quality,
              maxIterations: config.maxIterations,
              palette: CLASSIC_PALETTE,
              output: "escape-count",
            },
            result,
          );
          stage = result.stage;
          checksum = 0;
          interior = 0;
          for (const value of result.escapeCounts) {
            if (value < 0) interior++;
            else checksum += value;
          }
        }
        return {
          ms: (performance.now() - started) / repeats,
          stage,
          checksum,
          interior,
        };
      };
      const exact = await run("exact");
      const preview = await run("preview");
      return {
        exactMs: exact.ms,
        previewMs: preview.ms,
        speedup: exact.ms / preview.ms,
        exactStage: exact.stage,
        previewStage: preview.stage,
        exactChecksum: exact.checksum,
        previewChecksum: preview.checksum,
        interiorPixels: exact.interior,
        pixels: tile.width * tile.height,
      };
    },

    async benchmarkBlaCarriers(config, repeats) {
      const view = buildView(config);
      const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
      const orbit = computeConvergedReferenceOrbit(
        reference,
        config.maxIterations + 1,
        view.width.fracBits,
      ).orbit;
      const table = buildBla(orbit, config.maxIterations, viewDiagonalMagnitude(view));
      if (table.blockExponent === 0) {
        throw new Error("benchmarkBlaCarriers: this view validated no jump");
      }
      const bits = orbit.fracBits;
      const requests: DeltaRequest[] = [];
      for (let y = 0; y < config.pixelHeight; y++) {
        for (let x = 0; x < config.pixelWidth; x++) {
          const c = pixelToComplex(view, x, y);
          const offset = bigComplex(
            {
              v: withFracBits(c.re, bits).v - withFracBits(orbit.center.re, bits).v,
              fracBits: bits,
            },
            {
              v: withFracBits(c.im, bits).v - withFracBits(orbit.center.im, bits).v,
              fracBits: bits,
            },
          );
          const dc = floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im));
          requests.push({ dc, start: dc, startIteration: 1 });
        }
      }

      const engine = await perturbEngine();
      const js = createBlaCarrier(table);
      const wasm = engine.blaCarrier(table);
      let jsResults: PerturbationResult[] = [];
      let wasmResults: PerturbationResult[] = [];
      let jsMs = 0;
      let wasmMs = 0;
      for (let repeat = 0; repeat < Math.max(1, repeats); repeat++) {
        const jsStart = performance.now();
        jsResults = js.iterate(orbit, requests, config.maxIterations);
        jsMs += performance.now() - jsStart;
        const wasmStart = performance.now();
        wasmResults = wasm.iterate(orbit, requests, config.maxIterations);
        wasmMs += performance.now() - wasmStart;
      }
      let escapedJs = 0;
      let escapedWasm = 0;
      for (const result of jsResults)
        if (!result.glitched && result.escaped) escapedJs += 1;
      for (const result of wasmResults)
        if (!result.glitched && result.escaped) escapedWasm += 1;
      return {
        pixels: requests.length,
        iterations: config.maxIterations,
        blockExponent: table.blockExponent,
        orbitLength: orbit.length,
        identical: sameResults(jsResults, wasmResults).length === 0,
        mismatches: sameResults(jsResults, wasmResults),
        jsMs,
        wasmMs,
        speedup: wasmMs > 0 ? jsMs / wasmMs : 0,
        jsEscaped: escapedJs,
        wasmEscaped: escapedWasm,
        jsRefined: jsResults.filter(
          (result) => (result as { refined?: boolean }).refined === true,
        ).length,
        wasmRefined: wasmResults.filter(
          (result) => (result as { refined?: boolean }).refined === true,
        ).length,
      };
    },

    async benchmarkBla(config, repeats) {
      const view = buildView(config);
      const tile = { x: 0, y: 0, width: view.pixelWidth, height: view.pixelHeight };
      const engine = await perturbEngine();
      const run = async (quality: "preview" | "exact", carrier?: typeof engine) => {
        const backend = createCpuBackend({
          orbitCache: createLruCache(4),
          seriesCache: createLruCache(4),
          blaCache: createLruCache(4),
          perturbCarrier: carrier,
        });
        let stage = "";
        let counts = new Int32Array(0);
        const started = performance.now();
        for (let i = 0; i < repeats; i++) {
          const result = makeTileResult(tile.width, tile.height, "escape-count");
          await backend.render(
            {
              view,
              tile,
              step: 1,
              quality,
              maxIterations: config.maxIterations,
              palette: CLASSIC_PALETTE,
              output: "escape-count",
            },
            result,
          );
          stage = result.stage;
          counts = Int32Array.from(result.escapeCounts);
        }
        return { ms: (performance.now() - started) / repeats, stage, counts };
      };

      const exactJs = await run("exact");
      const exactWasm = await run("exact", engine);
      const preview = await run("preview");
      let differing = 0;
      let worstShift = 0;
      for (let i = 0; i < exactJs.counts.length; i++) {
        const left = exactJs.counts[i] as number;
        const right = preview.counts[i] as number;
        if (left !== right) {
          differing += 1;
          if (left >= 0 && right >= 0) {
            worstShift = Math.max(worstShift, Math.abs(left - right));
          }
        }
      }
      return {
        exactJsMs: exactJs.ms,
        exactWasmMs: exactWasm.ms,
        previewMs: preview.ms,
        exactJsStage: exactJs.stage,
        exactWasmStage: exactWasm.stage,
        previewStage: preview.stage,
        pixels: tile.width * tile.height,
        iterations: config.maxIterations,
        differing,
        worstShift,
      };
    },

    async benchmarkL0(pixels, maxIterations, repeats) {
      const js = createJsL0Engine();
      const wasm = await loadL0WasmEngine();
      // A row spanning the interesting part of the real axis.
      const request = {
        cRe0: -1.75,
        cIm: 0.1,
        dRe: 2.5 / pixels,
        count: pixels,
        maxIterations,
      };

      const run = (engine: typeof js): { result: L0RowResult; ms: number } => {
        const started = performance.now();
        let result: L0RowResult | null = null;
        for (let i = 0; i < repeats; i++) result = engine.renderRow(request);
        const ms = (performance.now() - started) / repeats;
        if (result === null) throw new Error("benchmarkL0: no run completed");
        return { result, ms };
      };

      const jsRun = run(js);
      const wasmRun = run(wasm);

      let mismatches = 0;
      for (let i = 0; i < pixels; i++) {
        const jsIterations = jsRun.result.iterations[i] as number;
        const wasmIterations = wasmRun.result.iterations[i] as number;
        if (jsIterations !== wasmIterations) {
          mismatches++;
          continue;
        }
        // Magnitudes only matter where a point escaped.
        if (jsIterations > 0) {
          const a = jsRun.result.magnitudeSquared[i] as number;
          const b = wasmRun.result.magnitudeSquared[i] as number;
          if (a !== b) mismatches++;
        }
      }

      return {
        jsName: js.name,
        wasmName: wasm.name,
        jsMs: jsRun.ms,
        wasmMs: wasmRun.ms,
        speedup: jsRun.ms / wasmRun.ms,
        mismatches,
        compared: pixels,
      };
    },

    scaleExponent(config) {
      return scaleExponentOf(buildView(config));
    },

    async renderStageFromPool(config) {
      const view = buildView(config);
      const pool = createWorkerPool({ size: 1 });
      try {
        const tile = { x: 0, y: 0, width: view.pixelWidth, height: view.pixelHeight };
        const result = makeTileResult(tile.width, tile.height, "escape-count");
        await pool.render(
          {
            view,
            tile,
            step: 1,
            quality: "exact",
            maxIterations: config.maxIterations,
            palette: CLASSIC_PALETTE,
            output: "escape-count",
          },
          result,
        );
        return result.stage;
      } finally {
        pool.dispose();
      }
    },

    async poolAfterDispose(config) {
      const view = buildView(config);
      const pool = createWorkerPool({ size: 1 });
      pool.dispose();
      try {
        await renderView({
          backend: pool,
          view,
          maxIterations: config.maxIterations,
          palette: CLASSIC_PALETTE,
          quality: "exact",
          passes: [{ name: "full", step: 1, samplesAcross: 8 }],
        });
        return "no error";
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },

    async renderWithPoolSized(config, concurrency, samplesAcross) {
      const view = buildView(config);
      const pool = createWorkerPool({ size: concurrency });
      try {
        const outcome = await renderView({
          backend: pool,
          view,
          maxIterations: config.maxIterations,
          palette: CLASSIC_PALETTE,
          quality: "exact",
          // `samplesAcross <= 0` means "ask the planner", which is what the app
          // does; a positive value forces a tile size for a measurement.
          passes:
            samplesAcross > 0
              ? [{ name: "full", step: 1, samplesAcross }]
              : passesFor(
                  "pool",
                  config.pixelWidth,
                  config.pixelHeight,
                  concurrency,
                ).filter((pass) => pass.step === 1),
          concurrency,
        });
        return { pool: poolInfo(pool), outcomeStages: [...outcome.stages] };
      } finally {
        pool.dispose();
      }
    },

    async renderWithPool(config, concurrency) {
      const view = buildView(config);
      const pool = createWorkerPool({ size: concurrency });
      try {
        const outcome = await renderView({
          backend: pool,
          view,
          maxIterations: config.maxIterations,
          palette: CLASSIC_PALETTE,
          quality: "exact",
          // The full pass at the tiling the app would choose for a pool, so this
          // pin tests the real tile size rather than a test-only one. The coarse
          // pass is left out because these pins compare one assembled image.
          passes: passesFor(
            "pool",
            config.pixelWidth,
            config.pixelHeight,
            concurrency,
          ).filter((pass) => pass.step === 1),
          concurrency,
        });
        const image = outcome.passes[0];
        if (!image) throw new Error("pool render produced no pass");
        // Escape counts are not what the pool's colour path returns, so the
        // comparison is done on colours: the scheduler's assembled image.
        const counts = Array.from(image.pixels);
        return {
          counts,
          stages: [...outcome.passes.map((pass) => pass.name)],
          outcomeStages: [...outcome.stages],
          pool: poolInfo(pool),
        };
      } finally {
        pool.dispose();
      }
    },
  };

  (window as unknown as { __orion: OrionHarness }).__orion = api;
}

const canvas = document.getElementById("canvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("harness: #canvas element missing");
}
install(canvas);
