/**
 * The direct engine: plain escape-time iteration of `z -> z^2 + c` at arbitrary
 * precision. No perturbation, no approximation, no shortcuts.
 *
 * It plays two roles, deliberately sharing one implementation:
 *
 *  1. **The L0 engine** — at shallow zoom, direct iteration is simply the
 *     fastest correct thing, and this is the CPU fallback when no GPU backend
 *     is available.
 *  2. **The verification oracle** — every accelerated engine (perturbation,
 *     series approximation, GPU shader kernels) is pinned against *this* code.
 *     Sharing the implementation means the pin compares the accelerated path
 *     against the path that actually ships as the fallback, not against a
 *     second, rosier definition of correctness.
 *
 * It is intentionally slow: clarity over speed, because a bug here would
 * silently bless a wrong fast path.
 */

import { type BigComplex, abs2Complex, bigComplex } from "../numeric/bigcomplex";
import { add, cmp, fromInt, mul, sub, toFloat } from "../numeric/bigfixed";

export type EscapeOutcome = {
  readonly escaped: boolean;
  /** Iterations of `z -> z^2 + c` performed (== maxIterations when bounded). */
  readonly iterations: number;
  /** Continuous escape count; `null` when the point did not escape. */
  readonly smooth: number | null;
};

const ESCAPE_RADIUS_SQUARED = 4;

export function escapeDirect(c: BigComplex, maxIterations: number): EscapeOutcome {
  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    throw new Error(
      `escapeDirect: maxIterations must be a positive integer (got ${maxIterations})`,
    );
  }
  const fracBits = c.re.fracBits;
  const escapeThreshold = fromInt(ESCAPE_RADIUS_SQUARED, fracBits);

  let zr = fromInt(0, fracBits);
  let zi = fromInt(0, fracBits);

  for (let n = 1; n <= maxIterations; n++) {
    // z = z^2 + c
    const zr2 = mul(zr, zr);
    const zi2 = mul(zi, zi);
    const nextZr = add(sub(zr2, zi2), c.re);
    const nextZi = add(mul(add(zr, zr), zi), c.im);
    zr = nextZr;
    zi = nextZi;

    const magnitudeSquared = abs2Complex(bigComplex(zr, zi));
    if (cmp(magnitudeSquared, escapeThreshold) > 0) {
      // The escape test above is exact. The projection to a double is not, and
      // near the threshold it can round |z|^2 down to exactly 4 — so the smooth
      // count is derived from a rounded magnitude and is good to well under one
      // iteration there. That is fine for the oracle's purpose (it is compared
      // against accelerated engines within a tolerance); what must never happen
      // is silent NaN/Infinity leaking out of the logarithm.
      const m2 = toFloat(magnitudeSquared);
      const smooth = n + 1 - Math.log2(Math.log2(Math.sqrt(m2)));
      if (!Number.isFinite(smooth)) {
        throw new Error(
          `escapeDirect: non-finite smooth count at n=${n} (|z|^2 = ${m2})`,
        );
      }
      return { escaped: true, iterations: n, smooth };
    }
  }

  return { escaped: false, iterations: maxIterations, smooth: null };
}
