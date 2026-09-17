/**
 * The CPU backend: the correctness reference every other backend is measured
 * against, and the engine that actually renders at depths where no GPU float
 * type can reach.
 *
 * It follows the ladder rather than picking one engine:
 *
 *  - `direct-f64` when the plan says the view is representable in doubles —
 *    plain JS numbers, millions of iterations per second;
 *  - `perturbation` otherwise, through the high-precision reference orbit, with
 *    glitched pixels repaired by the direct engine.
 *
 * Both paths are already pinned against the arbitrary-precision oracle, so this
 * backend inherits that evidence instead of restating it.
 */

import { colourFor } from "../color/palette";
import { type L0Engine, createJsL0Engine, smoothCount } from "../engines/directFloat";
import {
  type DeltaCarrier,
  type DeltaRequest,
  jsDeltaCarrier,
} from "../engines/perturbation";
import { addComplex } from "../numeric/bigcomplex";
import { fromBigFixed } from "../numeric/floatexp";
import { floatComplex } from "../numeric/floatcomplex";
import {
  type ConvergedOrbit,
  computeConvergedReferenceOrbit,
} from "../engines/reference";
import {
  type BlaTable,
  MIN_USEFUL_BLOCK_EXPONENT,
  buildBla,
  createBlaCarrier,
} from "../engines/bla";
import { escapeDirect } from "../engines/direct";
import { recordMeasurement, viewMeasurementKey } from "../ladder/measurements";
import { planView } from "../ladder/plan";
import { fromFloat, mul, toFloat, withFracBits } from "../numeric/bigfixed";
import { type BigComplex, bigComplex, subComplex } from "../numeric/bigcomplex";
import {
  type SeriesApproximation,
  buildSeries,
  offsetMagnitude,
  seriesStart,
} from "../engines/series";
import type { LruCache } from "./tiles";
import { type View, pixelToComplex, scaleExponentOf } from "../view/view";
import {
  type Capability,
  type FractalBackend,
  type TileRequest,
  type TileResult,
  assertTileFitsView,
  tileOutputSize,
} from "./backend";

export type OrbitCache = LruCache<string, ConvergedOrbit>;

export type CpuBackendOptions = {
  /**
   * The carrier for the L0 recurrence. Defaults to the JavaScript engine; the
   * worker passes the WASM one, and the stage string says which ran.
   */
  readonly l0?: L0Engine;
  /**
   * The carrier for the delta recurrence. Defaults to the JavaScript engine;
   * the worker passes the WASM one. The two are bit-identical by pin, so this is
   * a speed choice — and the stage string says which ran.
   */
  readonly perturbCarrier?: DeltaCarrier;
  /**
   * Factory for the WASM BLA carrier, when the injected carrier is a kernel that
   * can apply the jump tables. Absent means the JavaScript jump carrier is used.
   */
  readonly wasmBlaCarrier?: ((table: BlaTable) => DeltaCarrier) | null;
  /** Force a stage instead of letting the ladder choose; used by tests. */
  readonly forceStage?: "direct-f64" | "perturbation";
  /**
   * Shared reference-orbit cache.
   *
   * Because the reference point is the *view* centre, every tile of a view asks
   * for the same orbit — so with a cache the expensive high-precision setup runs
   * once per view instead of once per tile. Without one it runs per tile, which
   * is correct but wasteful; the scheduler's pins measure the difference.
   */
  readonly orbitCache?: OrbitCache;
  /**
   * Series-coefficient cache.
   *
   * Coefficients cost about as much to build as the reference orbit and are
   * shared the same way — one set per view, not per tile — so they are cached
   * beside it and keyed the same way.
   */
  readonly seriesCache?: LruCache<string, SeriesApproximation>;
  /**
   * BLA table cache, keyed like the series: one table per view, shared by every
   * tile cut from it.
   */
  readonly blaCache?: LruCache<string, BlaTable>;
  /** Order of the series. Three terms is the measured sweet spot. */
  readonly seriesOrder?: number;
};

export function createCpuBackend(options: CpuBackendOptions = {}): FractalBackend {
  const l0 = options.l0 ?? createJsL0Engine();
  const perturbCarrier = options.perturbCarrier ?? jsDeltaCarrier;
  return {
    name: "cpu",

    capability(view, plan): Capability {
      if (view.pixelWidth < 1 || view.pixelHeight < 1) {
        return { supported: false, why: "view has no pixels" };
      }
      if (options.forceStage === "direct-f64" && scaleExponentOf(view) < -52) {
        return {
          supported: false,
          why: `f64 was forced, but the pixel spacing 2^${scaleExponentOf(view)} is below the double limit`,
        };
      }
      return {
        supported: true,
        why: `handles any depth; ladder plan selects ${plan.stage}`,
      };
    },

    async render(request: TileRequest, into: TileResult): Promise<TileResult> {
      assertTileFitsView(request.view, request.tile, request.allowOutsideView ?? false);
      const expected = tileOutputSize(request.tile, request.step);
      if (into.width !== expected.width || into.height !== expected.height) {
        throw new Error(
          `cpu backend: result buffer is ${into.width}x${into.height}, but a ${request.tile.width}x${request.tile.height} tile at step ${request.step} is ${expected.width}x${expected.height}`,
        );
      }
      if (request.output === "escape-count" && into.escapeCounts.length === 0) {
        throw new Error("cpu backend: escape-count output needs a result built for it");
      }

      const plan = planView({
        scaleExponent: scaleExponentOf(request.view),
        maxIterations: request.maxIterations,
        pixelCount: request.tile.width * request.tile.height,
        quality: request.quality,
      });
      const stage = options.forceStage ?? plan.stage;

      if (stage === "perturbation") {
        // `preview` may take the series accelerator; `exact` never does. That is
        // the whole meaning of the quality field, and it is why the series work
        // from the S1d landing is wired here rather than into the exact path —
        // its results are close, not identical (ledger row 11).
        //
        // The render is called unconditionally. Writing this as
        // `quality === "preview" && renderPerturbation(...)` reads the same and
        // renders *nothing* for `exact`, because `&&` short-circuits the call.
        const rendered = renderPerturbation(request, into, options, perturbCarrier);
        // The stage names every accelerator that actually ran, because both are
        // approximations and a caller that cannot tell them apart cannot tell
        // preview output from exact output.
        const accelerators = [
          rendered.series ? "series" : null,
          rendered.bla ? "bla" : null,
        ].filter((part): part is string => part !== null);
        const suffix = rendered.carrier === "wasm" ? "-wasm" : "";
        into.stage = `perturbation${accelerators.map((part) => `+${part}`).join("")}${suffix}`;
      } else {
        renderDirectFloat(request, into, l0);
        into.stage = l0.simd ? "direct-f64-simd" : "direct-f64";
      }
      return into;
    },

    dispose(): void {
      // Nothing to release: the CPU backend holds no resources between calls.
    },
  };
}

function storePixel(
  request: TileRequest,
  into: TileResult,
  index: number,
  escaped: boolean,
  iterations: number,
  smooth: number | null,
): void {
  if (request.output === "escape-count") {
    into.escapeCounts[index] = escaped ? iterations : -1;
    return;
  }
  const colour = colourFor({ escaped, smooth }, request.palette);
  const offset = index * 4;
  into.pixels[offset] = colour.r;
  into.pixels[offset + 1] = colour.g;
  into.pixels[offset + 2] = colour.b;
  into.pixels[offset + 3] = 255;
}

/**
 * Render a tile row by row through the L0 engine.
 *
 * Row-wise rather than pixel-wise because the engine is where SIMD lives: two
 * pixels of an `f64x2` pair advance together, and a per-pixel call would fill a
 * single lane and waste the other.
 */
function renderDirectFloat(
  request: TileRequest,
  into: TileResult,
  engine: L0Engine,
): void {
  const { view, tile, step } = request;
  const first = pixelToComplex(view, tile.x, tile.y);
  const second = pixelToComplex(view, tile.x + step, tile.y);
  const cRe0 = toFloat(first.re);
  const dRe = toFloat(second.re) - cRe0;

  for (let row = 0; row < into.height; row++) {
    const cIm = toFloat(pixelToComplex(view, tile.x, tile.y + row * step).im);
    const rowResult = engine.renderRow({
      cRe0,
      cIm,
      dRe,
      count: into.width,
      maxIterations: request.maxIterations,
    });
    const offset = row * into.width;
    for (let column = 0; column < into.width; column++) {
      const iterations = rowResult.iterations[column] ?? 0;
      if (iterations > 0) {
        storePixel(
          request,
          into,
          offset + column,
          true,
          iterations,
          smoothCount(iterations, rowResult.magnitudeSquared[column] ?? 0),
        );
      } else {
        storePixel(request, into, offset + column, false, request.maxIterations, null);
      }
    }
  }
}

/** Cache key for a reference orbit: full precision, so it cannot collide. */
export function orbitCacheKey(reference: BigComplex, iterations: number): string {
  return `${reference.re.v}|${reference.im.v}|${reference.re.fracBits}|${iterations}`;
}

function renderPerturbation(
  request: TileRequest,
  into: TileResult,
  options: CpuBackendOptions,
  carrier: DeltaCarrier,
): { readonly series: boolean; readonly bla: boolean; readonly carrier: string } {
  const { view, tile, step } = request;
  // One reference point for the whole *view*, not per tile: every tile of a view
  // then shares a single reference orbit, which is what makes the orbit cache
  // worth having. The view centre is the standard choice.
  const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
  const iterations = request.maxIterations + 1;
  const key = orbitCacheKey(reference, iterations);
  let converged = options.orbitCache?.get(key);
  if (converged === undefined) {
    converged = computeConvergedReferenceOrbit(
      reference,
      iterations,
      view.width.fracBits,
    );
    options.orbitCache?.set(key, converged);
  }

  // The series is built once per view and reused by every tile, exactly like the
  // orbit — and only for `preview`, because its results are close but not
  // identical to the exact path (ledger row 11).
  const order = options.seriesOrder ?? 3;
  let series: SeriesApproximation | null = null;
  if (request.quality === "preview") {
    const seriesKey = `${key}|${order}|${request.maxIterations}|${view.width.v}|${view.pixelWidth}x${view.pixelHeight}`;
    series = options.seriesCache?.get(seriesKey) ?? null;
    if (series === null) {
      series = buildSeries(
        converged.orbit,
        order,
        request.maxIterations,
        viewDiagonalMagnitude(view),
      );
      options.seriesCache?.set(seriesKey, series);
      // Tell the ladder what this view actually validated, so the next plan for
      // it can price the series stage honestly instead of assuming no skip.
      recordMeasurement(viewMeasurementKey(view, request.maxIterations), {
        seriesSkip: series.skipIterations,
      });
    }
  }
  // BLA is the second preview accelerator, and the more powerful one at depth:
  // where the series skips a validated *prefix*, BLA jumps blocks all the way
  // through, which is the regime the series has already left behind.
  let bla: BlaTable | null = null;
  if (request.quality === "preview") {
    const blaKey = `${key}|bla|${request.maxIterations}|${view.width.v}|${view.pixelWidth}x${view.pixelHeight}`;
    bla = options.blaCache?.get(blaKey) ?? null;
    if (bla === null) {
      bla = buildBla(
        converged.orbit,
        request.maxIterations,
        viewDiagonalMagnitude(view),
      );
      options.blaCache?.set(blaKey, bla);
    }
  }

  // Which carrier iterates the deltas. BLA is JavaScript and costs two complex
  // multiplies per jump, so it only wins when a jump is long enough to beat `m`
  // iterations of the WASM kernel: measured ~166ns per iteration there against
  // ~0.6us per jump here, which crosses over around four iterations.
  const blaUsable = bla !== null && 1 << bla.blockExponent >= MIN_BLA_BLOCK;
  // The jumps go through the WASM kernel when one is injected: the same
  // algorithm applied to the same coefficients (the table is composed here
  // either way), measured faster. The JavaScript carrier stays for a backend
  // that has no kernel.
  const activeCarrier: DeltaCarrier =
    !blaUsable || bla === null
      ? carrier
      : options.wasmBlaCarrier
        ? options.wasmBlaCarrier(bla)
        : createBlaCarrier(bla);

  // The orbit is computed at a precision the convergence check *raised*, so
  // pixel coordinates are lifted to match it before subtracting. Raising is
  // exact; doing it here rather than inside the engine keeps the no-silent-
  // rescaling rule intact.
  const orbitFracBits = converged.orbit.fracBits;

  // Every pixel of the tile is planned first, then handed to the carrier as one
  // batch: the delta recurrence is the hot loop, so the carrier is called once
  // per tile rather than once per pixel, and both carriers receive the identical
  // plan (which iteration to start at, and from which delta).
  const plans: {
    readonly index: number;
    readonly offset: BigComplex;
    readonly request: DeltaRequest;
  }[] = [];
  for (let row = 0; row < into.height; row++) {
    for (let column = 0; column < into.width; column++) {
      const c = pixelToComplex(view, tile.x + column * step, tile.y + row * step);
      const lifted = bigComplex(
        withFracBits(c.re, orbitFracBits),
        withFracBits(c.im, orbitFracBits),
      );
      const offset = subComplex(lifted, converged.orbit.center);
      const dc = floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im));
      plans.push({
        index: row * into.width + column,
        offset,
        request:
          series === null
            ? { dc, start: dc, startIteration: 1 }
            : seriesStart(converged.orbit, series, dc),
      });
    }
  }

  const results = activeCarrier.iterate(
    converged.orbit,
    plans.map((plan) => plan.request),
    request.maxIterations,
  );

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const result = results[i];
    if (!plan || !result) {
      throw new Error(
        `cpu backend: carrier returned ${results.length} results for ${plans.length} pixels`,
      );
    }
    // A glitched pixel is recomputed from scratch at full precision — the same
    // repair the single-pixel path did, kept here so the carrier cannot change
    // which pixels are repaired.
    const outcome = result.glitched
      ? escapeDirect(
          addComplex(converged.orbit.center, plan.offset),
          request.maxIterations,
        )
      : result;
    storePixel(
      request,
      into,
      plan.index,
      outcome.escaped,
      outcome.iterations,
      outcome.smooth,
    );
  }

  return { series: series !== null, bla: blaUsable, carrier: activeCarrier.kind };
}

/**
 * Shortest BLA jump worth taking.
 *
 * Measured crossover: the WASM exact kernel costs ~166ns per iteration, a BLA
 * jump in JavaScript costs roughly what 4 iterations would. Below this the
 * exact carrier wins, so BLA is not used and the stage does not claim it.
 */
const MIN_BLA_BLOCK = 1 << MIN_USEFUL_BLOCK_EXPONENT;

/**
 * The largest `|dc|` in the view: half its diagonal.
 *
 * Derived from the width rather than measured in floats, so it stays meaningful
 * far below the double range where the width itself underflows.
 */
export function viewDiagonalMagnitude(view: View) {
  const aspect = view.pixelHeight / view.pixelWidth;
  const factor = 0.5 * Math.sqrt(1 + aspect * aspect);
  const half = mul(view.width, fromFloat(factor, view.width.fracBits));
  return offsetMagnitude(bigComplex(half, { v: 0n, fracBits: view.width.fracBits }));
}
