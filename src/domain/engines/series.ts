/**
 * Series approximation: skip the first N delta iterations entirely.
 *
 * ## The idea
 *
 * `d_n` is an analytic function of the offset `dc`, so write it as a power
 * series and propagate the coefficients instead of a single value:
 *
 *     d_n = sum_{k>=1} a_{n,k} * dc^k
 *
 * Substituting into `d_{n+1} = 2*Z_n*d_n + d_n^2 + dc` and matching powers gives
 * a recurrence that costs `O(order^2)` per iteration, paid *once* for the whole
 * view:
 *
 *     a_{1,1} = 1,  a_{1,k>1} = 0
 *     a_{n+1,1} = 2*Z_n*a_{n,1} + 1
 *     a_{n+1,k} = 2*Z_n*a_{n,k} + sum_{j=1}^{k-1} a_{n,j}*a_{n,k-j}   (k > 1)
 *
 * Any pixel can then start at iteration N with `d_N` evaluated by Horner in
 * `order` complex multiplications instead of iterating N times. N is typically
 * in the thousands, which makes this the biggest speed lever in deep zoom.
 *
 * ## How far to skip: validate, do not extrapolate
 *
 * The first implementation estimated the truncated tail by assuming the
 * coefficients keep shrinking geometrically. Measurement killed it: on real
 * orbits the coefficients *grow* with order, and the estimate under-reported
 * the true truncation error by more than twenty orders of magnitude. No safety
 * factor repairs a bound whose shape is wrong.
 *
 * So the skip point is not extrapolated, it is **validated**: for a set of
 * sample offsets spanning the view, the series prediction at each candidate
 * iteration is compared against the exact delta iteration, and the largest
 * iteration whose worst relative error stays inside tolerance is the one used.
 * The measured worst absolute error travels with the series as `errorBound`.
 *
 * This is validation, not proof: it samples the view rather than enclosing it.
 * The guarantee it actually provides is the one pinned in `series.test.ts` —
 * for every pixel of the tested views, the true truncation error stayed inside
 * `errorBound`. If that ever fails, the pin fails.
 */

import { type BigComplex, addComplex } from "../numeric/bigcomplex";
import {
  type Floatexp,
  cmp,
  div as feDiv,
  fromBigFixed,
  fromFloat,
  mul as feMul,
  sqrt,
  toFloat,
} from "../numeric/floatexp";
import {
  abs2FloatComplex,
  addFloatComplex,
  type FloatComplex,
  floatComplex,
  mulFloatComplex,
  subFloatComplex,
} from "../numeric/floatcomplex";
import {
  type FloatComplexArray,
  allocateFloatComplexArray,
  readFloatComplex,
  writeFloatComplex,
} from "../numeric/floatexparray";
import { escapeDirect } from "./direct";
import {
  assertPerturbationInputs,
  type DeltaRequest,
  deltaStep,
  iterateDeltas,
  type PerturbationResult,
} from "./perturbation";
import type { ReferenceOrbit } from "./reference";

/**
 * Largest tolerated truncation error, relative to the leading term, at the
 * chosen skip point. Mirrors the glitch threshold's reasoning: ~24 bits of
 * headroom below the 53-bit mantissa.
 */
export const SERIES_RELATIVE_TOLERANCE = 2 ** -24;

const TOLERANCE = fromFloat(SERIES_RELATIVE_TOLERANCE);
const ONE = fromFloat(1);
const ZERO = fromFloat(0);
const ESCAPE_THRESHOLD = fromFloat(4);

export type SeriesCoefficients = {
  /** Highest power of `dc` carried into the evaluation. */
  readonly order: number;
  /** Number of iterations the coefficients cover. */
  readonly length: number;
  /** `terms[k - 1]` holds `a_{n,k}` for `k = 1..order`, `n = 0..length-1`. */
  readonly terms: readonly FloatComplexArray[];
};

export type SeriesApproximation = SeriesCoefficients & {
  /** Iteration a pixel may start at, or `0` when no skip validated. */
  readonly skipIterations: number;
  /** Worst relative truncation error measured at the skip point. */
  readonly maxRelativeError: number;
  /** Worst *absolute* truncation error measured at the skip point. */
  readonly errorBound: Floatexp;
};

/**
 * Compute `a_{n,k}` for `k = 1..order` and `n = 0..min(maxIterations, orbit.length)-1`.
 */
export function computeSeriesCoefficients(
  orbit: ReferenceOrbit,
  order: number,
  maxIterations: number,
): SeriesCoefficients {
  if (!Number.isInteger(order) || order < 1) {
    throw new Error(
      `computeSeriesCoefficients: order must be a positive integer (got ${order})`,
    );
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(
      `computeSeriesCoefficients: maxIterations must be a positive integer (got ${maxIterations})`,
    );
  }

  const length = Math.min(maxIterations, orbit.length);
  const terms: FloatComplexArray[] = [];
  for (let k = 0; k < order; k++) terms.push(allocateFloatComplexArray(length));

  if (length > 0) {
    // a_{1,1} = 1; every other coefficient at n = 1 is zero.
    writeFloatComplex(terms[0] as FloatComplexArray, 0, floatComplex(ONE, ZERO));
  }
  if (length > 1) {
    writeFloatComplex(terms[0] as FloatComplexArray, 1, floatComplex(ONE, ZERO));
  }

  for (let n = 1; n + 1 < length; n++) {
    const twiceZn = addFloatComplex(
      readFloatComplex(orbit, n),
      readFloatComplex(orbit, n),
    );
    const previous = terms.map((term) => readFloatComplex(term, n));
    const next: FloatComplex[] = [];

    for (let k = 1; k <= order; k++) {
      let value = mulFloatComplex(twiceZn, previous[k - 1] as FloatComplex);
      for (let j = 1; j < k; j++) {
        value = addFloatComplex(
          value,
          mulFloatComplex(
            previous[j - 1] as FloatComplex,
            previous[k - j - 1] as FloatComplex,
          ),
        );
      }
      if (k === 1) value = addFloatComplex(value, floatComplex(ONE, ZERO));
      next.push(value);
    }

    for (let k = 0; k < order; k++) {
      writeFloatComplex(terms[k] as FloatComplexArray, n + 1, next[k] as FloatComplex);
    }
  }

  return { order, length, terms };
}

/**
 * Sample offsets spanning a view: evenly spaced directions at `maxOffset` and
 * at half of it. The tail error grows with `|dc|`, so the outer ring is the
 * binding case; the inner ring catches an error that is not monotone in radius.
 */
export function sampleOffsets(maxOffset: Floatexp, perRing = 8): FloatComplex[] {
  if (perRing < 1 || !Number.isInteger(perRing)) {
    throw new Error(
      `sampleOffsets: perRing must be a positive integer (got ${perRing})`,
    );
  }
  const samples: FloatComplex[] = [];
  for (const radius of [maxOffset, feMul(maxOffset, fromFloat(0.5))]) {
    for (let i = 0; i < perRing; i++) {
      const angle = (2 * Math.PI * i) / perRing;
      samples.push(
        floatComplex(
          feMul(fromFloat(Math.cos(angle)), radius),
          feMul(fromFloat(Math.sin(angle)), radius),
        ),
      );
    }
  }
  return samples;
}

type Validation = {
  readonly skipIterations: number;
  readonly maxRelativeError: number;
  readonly errorBound: Floatexp;
};

/**
 * Find the largest iteration whose series prediction matches the exact delta
 * iteration on every sample, within `tolerance` relative to the leading term.
 *
 * Stops at the first failure rather than the last: a bound that fails and
 * recovers has already lost the prefix, and starting after the gap would
 * silently discard the divergence.
 */
export function selectSeriesSkip(
  orbit: ReferenceOrbit,
  coefficients: SeriesCoefficients,
  samples: readonly FloatComplex[],
  tolerance = TOLERANCE,
): Validation {
  const { length } = coefficients;
  if (samples.length === 0) {
    throw new Error("selectSeriesSkip: at least one sample offset is required");
  }

  const worstRelative = new Float64Array(length).fill(0);
  const worstAbsolute: Floatexp[] = new Array<Floatexp>(length).fill(ZERO);
  const alive = new Int32Array(length).fill(0);
  const toleranceValue = toFloat(tolerance);

  for (const dc of samples) {
    let d = dc; // d_1
    for (let n = 1; n < length; n++) {
      const seriesValue = evaluateCoefficientsAt(coefficients, n, dc);
      const error = abs2FloatComplex(subFloatComplex(d, seriesValue));
      const leading = feMul(
        abs2FloatComplex(
          readFloatComplex(coefficients.terms[0] as FloatComplexArray, n),
        ),
        abs2FloatComplex(dc),
      );
      if (leading.m !== 0) {
        const relative = toFloat(feDiv(error, leading));
        if (Number.isFinite(relative) && relative > (worstRelative[n] as number)) {
          worstRelative[n] = relative;
        }
      }
      if (cmp(error, worstAbsolute[n] as Floatexp) > 0) {
        worstAbsolute[n] = error;
      }
      alive[n] = (alive[n] as number) + 1;

      // Stop validating this sample once its own orbit escapes. Past escape the
      // delta grows without bound — and `d*d` doubles its exponent every step,
      // so iterating on would overflow rather than measure anything useful.
      // Pixels that escape inside the prefix are refused their skip one by one
      // in `escapePerturbedWithSeries`; they must not poison the bound for the
      // pixels that do not escape.
      const z = addFloatComplex(readFloatComplex(orbit, n), d);
      if (cmp(abs2FloatComplex(z), ESCAPE_THRESHOLD) > 0) break;

      if (n + 1 < length) d = deltaStep(readFloatComplex(orbit, n), d, dc);
    }
  }

  let skipIterations = 0;
  let maxRelativeError = 0;
  let errorBound: Floatexp = ZERO;
  for (let n = 1; n < length; n++) {
    // No sample survived this far, so nothing validated the series here.
    if (alive[n] === 0) break;
    if ((worstRelative[n] as number) > toleranceValue) break;
    skipIterations = n;
    maxRelativeError = worstRelative[n] as number;
    errorBound = worstAbsolute[n] as Floatexp;
  }

  // Starting at iteration 1 reproduces `d_1 = dc` exactly, i.e. no skip at all;
  // report that honestly as zero rather than as a skip of one.
  if (skipIterations < 2) {
    return { skipIterations: 0, maxRelativeError: 0, errorBound: ZERO };
  }
  return { skipIterations, maxRelativeError, errorBound };
}

/** Convenience: coefficients plus a validated skip point. */
export function buildSeries(
  orbit: ReferenceOrbit,
  order: number,
  maxIterations: number,
  maxOffset: Floatexp,
  tolerance = TOLERANCE,
): SeriesApproximation {
  if (maxOffset.m <= 0) {
    throw new Error("buildSeries: maxOffset must be positive");
  }
  const coefficients = computeSeriesCoefficients(orbit, order, maxIterations);
  const validation = selectSeriesSkip(
    orbit,
    coefficients,
    sampleOffsets(maxOffset),
    tolerance,
  );
  return { ...coefficients, ...validation };
}

/**
 * Horner evaluation of `sum_{k=1..K} a_{n,k} dc^k`.
 *
 * Factored as `((a_K*dc + a_{K-1})*dc + ...)*dc` so the leading `dc` of every
 * term is applied exactly once — the obvious `acc*dc + a_k` form omits one
 * factor of `dc` and returns a series in `dc^(k-1)`.
 */
export function evaluateCoefficientsAt(
  coefficients: SeriesCoefficients,
  n: number,
  offset: FloatComplex,
): FloatComplex {
  if (n < 0 || n >= coefficients.length) {
    throw new Error(
      `SeriesCoefficients: index ${n} out of range [0, ${coefficients.length})`,
    );
  }
  let accumulator = floatComplex(ZERO, ZERO);
  for (let k = coefficients.order; k >= 1; k--) {
    const term = readFloatComplex(coefficients.terms[k - 1] as FloatComplexArray, n);
    accumulator = mulFloatComplex(addFloatComplex(accumulator, term), offset);
  }
  return accumulator;
}

/** Horner evaluation at the series' own skip point. */
export function evaluateSeriesAt(
  series: SeriesApproximation,
  offset: FloatComplex,
): FloatComplex {
  if (series.skipIterations < 1) {
    throw new Error("SeriesApproximation: no validated skip to evaluate");
  }
  return evaluateCoefficientsAt(series, series.skipIterations, offset);
}

/** Offset magnitude of a full-precision offset, as a floatexp. */
/**
 * `|offset|` — the magnitude, *not* its square.
 *
 * The name said magnitude from the start and the body returned `|z|^2`, which
 * made every caller of `viewDiagonalMagnitude` sample the validation at the
 * *square* of the view's half-diagonal. On a 2^-100 view that is a 2^-200
 * neighbourhood: the accelerator was validated on a population far easier than
 * the pixels it was applied to, so its skip point and error bound were
 * optimistic. `series.test.ts` pins the radius against the view from here on.
 */
export function offsetMagnitude(offset: BigComplex): Floatexp {
  return sqrt(
    abs2FloatComplex(floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im))),
  );
}

export type SeriesEscapeResult = {
  readonly escaped: boolean;
  readonly iterations: number;
  readonly smooth: number | null;
  readonly engine: "perturbation" | "direct-repair";
  /** Iterations actually skipped for this pixel; `0` when the skip was unusable. */
  readonly skipped: number;
};

/**
 * Perturbation with a series-approximated prefix, and explicit repair.
 *
 * A skip is refused for a pixel whose orbit escaped during the skipped prefix:
 * `|z| >= 2` at the skip point implies it escaped somewhere in between, because
 * escape is monotone (`|z| > 2` implies `|z^2 + c| >= |z|^2 - 2 > 2`). Such a
 * pixel reports `skipped: 0` and is iterated in full — slower, never wrong, and
 * observable rather than silent.
 */
/**
 * Where this pixel's delta iteration starts, given the series approximation.
 *
 * The decision — skip the validated prefix, or refuse the skip for a pixel whose
 * orbit already escaped inside it — is *one* decision, so it lives in one place
 * and both carriers are told the answer rather than each re-deriving it. The
 * JavaScript carrier and the WASM kernel then run the identical loop from the
 * identical starting point, which is what makes their outputs comparable.
 */
export function seriesStart(
  orbit: ReferenceOrbit,
  series: SeriesApproximation,
  dc: FloatComplex,
): DeltaRequest {
  const candidate = series.skipIterations;
  if (candidate >= 1 && candidate < orbit.length) {
    const startDelta = evaluateSeriesAt(series, dc);
    const z = addFloatComplex(readFloatComplex(orbit, candidate), startDelta);
    if (cmp(abs2FloatComplex(z), ESCAPE_THRESHOLD) <= 0) {
      return { dc, start: startDelta, startIteration: candidate };
    }
  }
  return { dc, start: dc, startIteration: 1 };
}

export function escapePerturbedWithSeries(
  orbit: ReferenceOrbit,
  series: SeriesApproximation,
  offset: BigComplex,
  maxIterations: number,
): SeriesEscapeResult {
  assertPerturbationInputs(orbit, offset, maxIterations);
  const dc = floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im));
  const request = seriesStart(orbit, series, dc);
  const skipped = request.startIteration === 1 ? 0 : request.startIteration;
  const result: PerturbationResult = iterateDeltas(
    orbit,
    request.dc,
    request.startIteration,
    request.start,
    maxIterations,
  );

  if (result.glitched) {
    return {
      ...escapeDirect(addComplex(orbit.center, offset), maxIterations),
      engine: "direct-repair",
      skipped,
    };
  }
  return {
    escaped: result.escaped,
    iterations: result.iterations,
    smooth: result.smooth,
    engine: "perturbation",
    skipped,
  };
}
