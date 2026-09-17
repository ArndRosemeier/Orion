/**
 * The perturbation engine: render a neighbourhood of the reference point by
 * iterating only the *difference*.
 *
 * The reference orbit satisfies `Z_{n+1} = Z_n^2 + C`. For a nearby point
 * `c = C + dc`, subtracting the two recurrences gives the exact identity
 *
 *     d_{n+1} = 2*Z_n*d_n + d_n^2 + dc,   d_0 = 0, d_1 = dc,   z_n = Z_n + d_n
 *
 * which is what makes arbitrarily deep zoom tractable: `dc` is a view-scale
 * number that a double carries with full relative precision, however deep the
 * view, so the per-pixel work never needs the wide exponent that `C` needs.
 *
 * ## Why this needs a glitch criterion
 *
 * The identity is exact, but the *floating-point* evaluation is not. `z_n` is
 * formed as `Z_n + d_n`, and when those two nearly cancel — which happens
 * wherever a pixel's orbit passes much closer to zero than the reference's —
 * the sum keeps only the few bits left over. From that iteration on, `d` is
 * meaningless and the pixel would be coloured wrongly and *plausibly*, which is
 * the worst possible failure. Pauldelbrot's criterion detects exactly this
 * cancellation: flag when `|z|^2` drops below `|Z|^2 * GLITCH_RELATIVE_SQUARED`.
 *
 * A flagged pixel is not guessed at or fudged; it is handed back as `glitched`
 * so the caller can repair it with the direct engine (`escapeWithRepair`). The
 * `glitched` result is deliberately a distinct case in the return type, so a
 * caller cannot silently consume an untrustworthy value.
 */

import { type BigComplex, addComplex } from "../numeric/bigcomplex";
import { type Floatexp, cmp, fromBigFixed, fromFloat, mul } from "../numeric/floatexp";
import {
  abs2FloatComplex,
  addFloatComplex,
  type FloatComplex,
  floatComplex,
  mulFloatComplex,
} from "../numeric/floatcomplex";
import { readFloatComplex } from "../numeric/floatexparray";
import { type EscapeOutcome, escapeDirect } from "./direct";
import type { ReferenceOrbit } from "./reference";

/**
 * Glitch threshold on squared magnitudes: `|z|^2 < |Z|^2 * 2^-24`.
 *
 * Forming `z = Z + d` when the two nearly cancel costs about
 * `log2(|Z|/|z|)` bits, so this keeps at least 12 bits of headroom before the
 * cancellation can reach the low end of a 53-bit mantissa. It is a *detection*
 * threshold, not a correctness one: anything it misses is caught by the
 * differential pin, which asserts that no unrepaired pixel ever disagrees with
 * the direct engine.
 */
export const GLITCH_RELATIVE_SQUARED = 2 ** -24;

const GLITCH_THRESHOLD = fromFloat(GLITCH_RELATIVE_SQUARED);
const ESCAPE_THRESHOLD = fromFloat(4);

/**
 * Pauldelbrot's criterion, as a seam of its own so the *threshold* is pinnable.
 *
 * A view whose worst case is a total cancellation (`|z|^2 === 0`) would fire
 * under any positive threshold, so a rendered test alone cannot tell a working
 * threshold from a disabled one. This can.
 */
export function isGlitched(
  magnitudeSquared: Floatexp,
  referenceMagnitudeSquared: Floatexp,
): boolean {
  return cmp(magnitudeSquared, mul(referenceMagnitudeSquared, GLITCH_THRESHOLD)) < 0;
}

export type PerturbationResult =
  | {
      readonly glitched: false;
      readonly escaped: boolean;
      readonly iterations: number;
      readonly smooth: number | null;
    }
  | {
      readonly glitched: true;
      /** Iteration at which the delta became untrustworthy. */
      readonly iterations: number;
      readonly reason: "precision" | "orbit-exhausted";
    };

export function escapePerturbed(
  orbit: ReferenceOrbit,
  offset: BigComplex,
  maxIterations: number,
): PerturbationResult {
  assertPerturbationInputs(orbit, offset, maxIterations);
  const dc = floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im));
  return iterateDeltas(orbit, dc, 1, dc, maxIterations);
}

export function assertPerturbationInputs(
  orbit: ReferenceOrbit,
  offset: BigComplex,
  maxIterations: number,
): void {
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(
      `escapePerturbed: maxIterations must be a positive integer (got ${maxIterations})`,
    );
  }
  if (offset.re.fracBits !== orbit.fracBits) {
    throw new Error(
      `escapePerturbed: offset/reference precision mismatch (${offset.re.fracBits} vs ${orbit.fracBits} fractional bits)`,
    );
  }
}

/**
 * One step of the delta recurrence: `d_{n+1} = 2*Z_n*d_n + d_n^2 + dc`.
 *
 * Exported because it is the single definition of the recurrence: the escape
 * loop, the exact-delta reference used to measure the series approximation, and
 * any future GPU kernel all express the same step.
 */
export function deltaStep(
  zn: FloatComplex,
  d: FloatComplex,
  dc: FloatComplex,
): FloatComplex {
  const twiceZn = addFloatComplex(zn, zn);
  return addFloatComplex(
    addFloatComplex(mulFloatComplex(twiceZn, d), mulFloatComplex(d, d)),
    dc,
  );
}

/**
 * The exact delta `d_n` after `iterations` steps, with no skipping.
 *
 * This is what the series approximation is measured against: the difference
 * between the two is the truncation error the bound must never under-report.
 */
export function exactDelta(
  orbit: ReferenceOrbit,
  dc: FloatComplex,
  iterations: number,
): FloatComplex {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(
      `exactDelta: iterations must be a positive integer (got ${iterations})`,
    );
  }
  if (iterations >= orbit.length) {
    throw new Error(
      `exactDelta: orbit holds ${orbit.length} values, need more than ${iterations}`,
    );
  }
  let d: FloatComplex = dc;
  for (let n = 1; n < iterations; n++) {
    d = deltaStep(readFloatComplex(orbit, n), d, dc);
  }
  return d;
}

/**
 * The delta iteration itself, from an arbitrary starting point.
 *
 * `startIteration` is the iteration whose delta `startDelta` already represents
 * (`d_startIteration`). Starting from `(1, dc)` is plain perturbation; the
 * series approximation starts from a skipped prefix instead, which is the only
 * difference between the two paths — so they share this loop rather than
 * restating the recurrence.
 */
export function iterateDeltas(
  orbit: ReferenceOrbit,
  dc: FloatComplex,
  startIteration: number,
  startDelta: FloatComplex,
  maxIterations: number,
): PerturbationResult {
  let d: FloatComplex = startDelta;

  for (let n = startIteration; n <= maxIterations; n++) {
    if (n >= orbit.length) {
      // The reference escaped before this pixel could be resolved against it.
      return { glitched: true, iterations: n, reason: "orbit-exhausted" };
    }

    const zn = readFloatComplex(orbit, n);
    const z = addFloatComplex(zn, d);
    const magnitudeSquared = abs2FloatComplex(z);

    if (isGlitched(magnitudeSquared, abs2FloatComplex(zn))) {
      return { glitched: true, iterations: n, reason: "precision" };
    }

    if (cmp(magnitudeSquared, ESCAPE_THRESHOLD) > 0) {
      // log2|z|^2 read straight off mantissa and exponent, so a value far
      // outside the double range still yields the right smooth count.
      const log2MagnitudeSquared = Math.log2(magnitudeSquared.m) + magnitudeSquared.e;
      const smooth = n + 1 - Math.log2(0.5 * log2MagnitudeSquared);
      return { glitched: false, escaped: true, iterations: n, smooth };
    }

    d = deltaStep(zn, d, dc);
  }

  return { glitched: false, escaped: false, iterations: maxIterations, smooth: null };
}

/**
 * One pixel's work for a carrier: where the delta iteration starts, and the
 * offset it steps with.
 *
 * Plain perturbation starts at `(1, dc)`; the series approximation starts at
 * `(skipIterations, evaluateSeriesAt(dc))`. Naming both in one struct is what
 * lets the JavaScript and WASM carriers share a caller: the caller decides
 * *where* to start, the carrier decides only *how fast* to iterate.
 */
export type DeltaRequest = {
  /** The per-pixel offset `c - C`, needed by every step of the recurrence. */
  readonly dc: FloatComplex;
  /** The delta at `startIteration`. */
  readonly start: FloatComplex;
  readonly startIteration: number;
};

/**
 * A carrier for the delta recurrence.
 *
 * Two implementations exist — the JavaScript engine here and the WASM kernel in
 * `perturbWasm.ts` — and they are held to bit-identical output, so which one ran
 * is a performance fact rather than a correctness one. It is still *reported*,
 * because a carrier swap that silently produced different pixels would be the
 * worst outcome this project can have.
 */
export type DeltaCarrier = {
  readonly name: string;
  /**
   * Which family the carrier belongs to. The stage string reports it, so a
   * JavaScript accelerator can never be labelled as the WASM kernel.
   */
  readonly kind: "js" | "wasm";
  iterate(
    orbit: ReferenceOrbit,
    requests: readonly DeltaRequest[],
    maxIterations: number,
  ): PerturbationResult[];
};

/** The reference carrier: plain JavaScript, one pixel at a time. */
export const jsDeltaCarrier: DeltaCarrier = {
  name: "js-floatexp",
  kind: "js",
  iterate(orbit, requests, maxIterations) {
    return requests.map((request) =>
      iterateDeltas(
        orbit,
        request.dc,
        request.startIteration,
        request.start,
        maxIterations,
      ),
    );
  },
};

export type EscapeEngine = "perturbation" | "direct-repair";

export type RepairedEscape = EscapeOutcome & {
  readonly engine: EscapeEngine;
};

/**
 * Perturbation with explicit repair.
 *
 * A glitched pixel is recomputed from scratch by the direct engine at full
 * precision. That is expensive, which is the point: it happens only where the
 * fast path cannot be trusted, and the engine used is reported on every result
 * rather than hidden.
 */
export function escapeWithRepair(
  orbit: ReferenceOrbit,
  offset: BigComplex,
  maxIterations: number,
): RepairedEscape {
  const perturbed = escapePerturbed(orbit, offset, maxIterations);
  if (!perturbed.glitched) {
    return {
      escaped: perturbed.escaped,
      iterations: perturbed.iterations,
      smooth: perturbed.smooth,
      engine: "perturbation",
    };
  }
  return {
    ...escapeDirect(addComplex(orbit.center, offset), maxIterations),
    engine: "direct-repair",
  };
}
