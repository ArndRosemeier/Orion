/**
 * The L0 engine: escape-time iteration in hardware doubles.
 *
 * This is the cheapest rung of the ladder and the only one a fragment shader can
 * express directly, because GLSL has no `f64`. It is correct only while the
 * whole view is representable in doubles: a double carries 52 fraction bits plus
 * the implicit leading one, so once pixels are closer than ~2^-52 relative to
 * the centre, adjacent pixels map to the same number and the image collapses.
 *
 * ## One iteration, several carriers
 *
 * The recurrence exists once, here, in `escapeOne`/`iterateRow`. The JavaScript
 * engine wraps it directly; the Rust→WASM engine reimplements it and is held to
 * it by a **bit-identical** differential. Two carriers is not duplication to be
 * folded — a `cdylib` cannot call into TypeScript — it is duplication to be
 * *pinned*, and the pin is exact rather than tolerant.
 *
 * The engine renders a **row** rather than a pixel because SIMD needs lanes to
 * fill: two pixels of an `f64x2` pair advance together.
 */

import type { EscapeOutcome } from "./direct";

export const F64_ESCAPE_RADIUS_SQUARED = 4;

export type L0RowRequest = {
  /** Complex coordinate of the first pixel in the run. */
  readonly cRe0: number;
  readonly cIm: number;
  /** Real-axis step between adjacent pixels. */
  readonly dRe: number;
  readonly count: number;
  readonly maxIterations: number;
};

export type L0RowResult = {
  /** Escape iteration per pixel; `0` means the point stayed bounded. */
  readonly iterations: Int32Array;
  /** `|z|^2` at the escape step, or `0` when bounded. */
  readonly magnitudeSquared: Float64Array;
};

export type L0Engine = {
  readonly name: string;
  readonly simd: boolean;
  renderRow(request: L0RowRequest): L0RowResult;
};

export type EscapeDetail = {
  readonly escaped: boolean;
  readonly iterations: number;
  readonly magnitudeSquared: number;
};

/**
 * Iterate one point, returning the escape step and the magnitude there.
 *
 * The single definition of the recurrence in TypeScript. `escapeDirectFloat`
 * adds the continuous count on top, so there is no second copy of the loop.
 */
export function escapeDirectFloatDetailed(
  cRe: number,
  cIm: number,
  maxIterations: number,
): EscapeDetail {
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(
      `escapeDirectFloat: maxIterations must be a positive integer (got ${maxIterations})`,
    );
  }
  if (!Number.isFinite(cRe) || !Number.isFinite(cIm)) {
    throw new Error(`escapeDirectFloat: non-finite point (${cRe}, ${cIm})`);
  }

  let zr = 0;
  let zi = 0;
  for (let n = 1; n <= maxIterations; n++) {
    const zr2 = zr * zr;
    const zi2 = zi * zi;
    const nextZr = zr2 - zi2 + cRe;
    const nextZi = 2 * zr * zi + cIm;
    zr = nextZr;
    zi = nextZi;
    const magnitudeSquared = zr * zr + zi * zi;
    if (magnitudeSquared > F64_ESCAPE_RADIUS_SQUARED) {
      return { escaped: true, iterations: n, magnitudeSquared };
    }
  }
  return { escaped: false, iterations: maxIterations, magnitudeSquared: 0 };
}

/**
 * The continuous escape count for an escaped magnitude.
 *
 * Shared by every engine so the GPU, the CPU and the WASM core cannot drift on
 * the colouring formula even though they iterate in different places.
 */
export function smoothCount(iterations: number, magnitudeSquared: number): number {
  const smooth = iterations + 1 - Math.log2(0.5 * Math.log2(magnitudeSquared));
  if (!Number.isFinite(smooth)) {
    throw new Error(
      `escapeDirectFloat: non-finite smooth count at n=${iterations} (|z|^2 = ${magnitudeSquared})`,
    );
  }
  return smooth;
}

/**
 * Iterate `z -> z^2 + c` from `z = 0` in doubles.
 *
 * Returns the same continuous escape count as `escapeDirect`, computed the same
 * way, so the two can be compared directly at depths where both are valid.
 */
export function escapeDirectFloat(
  cRe: number,
  cIm: number,
  maxIterations: number,
): EscapeOutcome {
  const detail = escapeDirectFloatDetailed(cRe, cIm, maxIterations);
  if (!detail.escaped) {
    return { escaped: false, iterations: detail.iterations, smooth: null };
  }
  return {
    escaped: true,
    iterations: detail.iterations,
    smooth: smoothCount(detail.iterations, detail.magnitudeSquared),
  };
}

/** The JavaScript carrier for the recurrence. */
export function createJsL0Engine(): L0Engine {
  let iterations = new Int32Array(0);
  let magnitudes = new Float64Array(0);

  return {
    name: "js-f64",
    simd: false,

    renderRow(request): L0RowResult {
      if (!Number.isInteger(request.count) || request.count < 1) {
        throw new Error(
          `l0 row: count must be a positive integer (got ${request.count})`,
        );
      }
      if (iterations.length < request.count) {
        iterations = new Int32Array(request.count);
        magnitudes = new Float64Array(request.count);
      }
      const outIterations = iterations.subarray(0, request.count);
      const outMagnitudes = magnitudes.subarray(0, request.count);
      for (let i = 0; i < request.count; i++) {
        const detail = escapeDirectFloatDetailed(
          request.cRe0 + request.dRe * i,
          request.cIm,
          request.maxIterations,
        );
        outIterations[i] = detail.escaped ? detail.iterations : 0;
        outMagnitudes[i] = detail.escaped ? detail.magnitudeSquared : 0;
      }
      return { iterations: outIterations, magnitudeSquared: outMagnitudes };
    },
  };
}
