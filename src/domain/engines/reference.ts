/**
 * The reference orbit: the high-precision orbit of one chosen point, stored in
 * a form the per-pixel engine can consume.
 *
 * Perturbation theory renders a neighbourhood of `C` by iterating
 * `Z_{n+1} = Z_n^2 + C` once — at full precision — and then, per pixel, iterating
 * only the *difference* `d_{n+1} = 2*Z_n*d_n + d_n^2 + dc`. That turns an
 * arbitrarily-deep zoom into arithmetic on small numbers, which is the whole
 * reason deep zoom is tractable at all.
 *
 * Two design points that are easy to get wrong:
 *
 *  1. **The orbit is computed in fixed point, not in floatexp.** Each step
 *     amplifies error by roughly `|2*Z_n|`, so over a long orbit a 53-bit
 *     computation diverges from the true orbit entirely. The high precision is
 *     what makes the reference valid; the floatexp form is what makes it
 *     *storable* at scale.
 *  2. **The stored mantissa is only 53 bits, and that is fine.** The stored
 *     orbit is a rounded version of the true one. The delta recurrence is
 *     re-anchored each step by its exact `+ dc` term, so the rounding enters as
 *     a small additive perturbation of the *escape test* — a macroscopic test
 *     against radius 2 — not as a shifted starting point. (Treating a rounded
 *     orbit as if it were an exact orbit is the mistake that makes a deep
 *     renderer silently draw the wrong neighbourhood.)
 */

import {
  type BigComplex,
  abs2Complex,
  addComplex,
  bigComplex,
  mulComplex,
} from "../numeric/bigcomplex";
import { type BigFixed, cmp, fromInt, withFracBits } from "../numeric/bigfixed";
import {
  type Floatexp,
  abs as feAbs,
  cmp as feCmp,
  fromBigFixed,
  fromFloat,
  mul as feMul,
  sub as feSub,
} from "../numeric/floatexp";
import {
  type FloatComplexArray,
  allocateFloatComplexArray,
  readFloatComplex,
  trimFloatComplexArray,
  writeFloatComplex,
} from "../numeric/floatexparray";

export const REFERENCE_ESCAPE_RADIUS_SQUARED = 4;

export type ReferenceOrbit = FloatComplexArray & {
  /** The reference point the orbit belongs to, at full precision. */
  readonly center: BigComplex;
  readonly fracBits: number;
  /**
   * Index `m` at which `|Z_m|^2` first exceeded the escape radius, or `null` if
   * the orbit stayed bounded for the whole budget. Equals the direct engine's
   * iteration count for the same point — pinned across both engines.
   */
  readonly escapedAt: number | null;
};

/**
 * Iterate `Z_{n+1} = Z_n^2 + C` at `C`'s precision, stopping early once the
 * orbit escapes (past that point it is meaningless for perturbation and the
 * values would grow without bound).
 */
export function computeReferenceOrbit(
  center: BigComplex,
  iterations: number,
): ReferenceOrbit {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(
      `computeReferenceOrbit: iterations must be a positive integer (got ${iterations})`,
    );
  }

  const fracBits = center.re.fracBits;
  const escapeThreshold = fromInt(REFERENCE_ESCAPE_RADIUS_SQUARED, fracBits);

  const values = allocateFloatComplexArray(iterations);

  let zr: BigFixed = fromInt(0, fracBits);
  let zi: BigFixed = fromInt(0, fracBits);
  let length = 0;
  let escapedAt: number | null = null;

  for (let n = 0; n < iterations; n++) {
    writeFloatComplex(values, n, {
      re: fromBigFixed(zr),
      im: fromBigFixed(zi),
    });
    length = n + 1;

    if (cmp(abs2Complex(bigComplex(zr, zi)), escapeThreshold) > 0) {
      escapedAt = n;
      break;
    }

    const squared = mulComplex(bigComplex(zr, zi), bigComplex(zr, zi));
    const next = addComplex(squared, center);
    zr = next.re;
    zi = next.im;
  }

  return {
    ...trimFloatComplexArray(values, length),
    center,
    fracBits,
    escapedAt,
  };
}

/**
 * How closely two orbits computed at different precisions must agree before the
 * coarser one is called converged: `2^-50` relative, a few ulps below the
 * 53-bit mantissa the orbit is stored at.
 */
export const ORBIT_CONVERGENCE_TOLERANCE = 2 ** -50;

export type ConvergedOrbit = {
  readonly orbit: ReferenceOrbit;
  /** Working precision the accepted orbit was computed at. */
  readonly fracBits: number;
  /** How many doublings of precision it took to reach agreement. */
  readonly attempts: number;
};

/**
 * Compute a reference orbit at a precision that has been **verified**, not
 * guessed.
 *
 * The precision an orbit needs is set by how much its own rounding error gets
 * amplified: each step multiplies error by about `|2*Z_n|`, so a long orbit near
 * the boundary can need thousands of bits while a short one needs hundreds. The
 * worst-case bound (two bits per iteration) is far too pessimistic to use as a
 * budget — measured orbits that match the oracle at 1600 iterations were fine
 * at 256 bits — and a formula tight enough to be useful would be a guess.
 *
 * So this does not guess. It computes the orbit at `F` and at `2F` from the same
 * input and compares the *stored* values, which is exactly the quantity that
 * matters downstream. Agreement means the coarser computation had already
 * converged; disagreement means the precision was insufficient and is doubled.
 *
 * The cost is a small constant factor on setup, paid once per view, in exchange
 * for a precision claim that is checked rather than asserted. Failing to
 * converge within `maxFracBits` is a loud error — a silently under-precise orbit
 * is exactly the bug this exists to prevent.
 *
 * The search **never starts below the input's own precision**. Computing at less
 * than the reference point carries would round the user's coordinate away before
 * the orbit even begins, and the check could not notice: both the coarse and the
 * fine computation would then agree on the same degraded point.
 */
export function computeConvergedReferenceOrbit(
  center: BigComplex,
  iterations: number,
  minFracBits: number,
  maxFracBits = 1 << 16,
): ConvergedOrbit {
  if (!Number.isInteger(minFracBits) || minFracBits < 1) {
    throw new Error(
      `computeConvergedReferenceOrbit: minFracBits must be a positive integer (got ${minFracBits})`,
    );
  }
  let fracBits = Math.max(minFracBits, center.re.fracBits);
  for (let attempts = 1; fracBits <= maxFracBits; attempts++) {
    const coarse = computeReferenceOrbit(recentre(center, fracBits), iterations);
    const fine = computeReferenceOrbit(recentre(center, fracBits * 2), iterations);
    if (orbitsAgree(coarse, fine)) {
      return { orbit: fine, fracBits: fracBits * 2, attempts };
    }
    fracBits *= 2;
  }
  throw new Error(
    `computeConvergedReferenceOrbit: no convergence up to ${maxFracBits} fractional bits — the orbit needs more precision than the ladder allows`,
  );
}

/** Re-express a reference point at a different working precision. */
function recentre(center: BigComplex, fracBits: number): BigComplex {
  return bigComplex(
    withFracBits(center.re, fracBits),
    withFracBits(center.im, fracBits),
  );
}

function orbitsAgree(a: ReferenceOrbit, b: ReferenceOrbit): boolean {
  if (a.length !== b.length) return false;
  const tolerance = fromFloat(ORBIT_CONVERGENCE_TOLERANCE);
  for (let n = 0; n < a.length; n++) {
    const left = readFloatComplex(a, n);
    const right = readFloatComplex(b, n);
    if (!componentsAgree(left.re, right.re, tolerance)) return false;
    if (!componentsAgree(left.im, right.im, tolerance)) return false;
  }
  return true;
}

function componentsAgree(a: Floatexp, b: Floatexp, tolerance: Floatexp): boolean {
  if (a.m === 0 || b.m === 0) return a.m === b.m;
  const difference = feAbs(feSub(a, b));
  return feCmp(difference, feMul(feAbs(b), tolerance)) <= 0;
}
