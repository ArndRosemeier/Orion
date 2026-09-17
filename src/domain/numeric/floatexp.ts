/**
 * Floatexp: a real value carried as a mantissa and an **unbounded integer
 * exponent**, `value = m * 2^e`, normalised so that `0.5 <= |m| < 1` (or
 * `m === 0` with `e === 0`).
 *
 * Why this exists: at depth, a reference orbit legitimately contains values far
 * below the double range — `|Z_n|` can be ~2^-2000, and products inside the
 * delta iteration go lower still. A plain double underflows to zero there and
 * silently turns a valid reference orbit into a degenerate one: the fast path
 * would keep producing plausible-looking output that is simply wrong. Splitting
 * the exponent out keeps all 53 significant bits of the mantissa no matter how
 * extreme the scale.
 *
 * Mantissa arithmetic itself stays in hardware doubles — this is not a
 * higher-precision type, it is a *wider-range* one. Significant bits are still
 * 53, which is exactly what the per-pixel engine consumes.
 */

import { type BigFixed, topBits } from "./bigfixed";

export type Floatexp = {
  readonly m: number;
  readonly e: number;
};

export const FLOATEXP_ZERO: Floatexp = { m: 0, e: 0 };

/** Significant bits carried by a floatexp mantissa. */
export const FLOATEXP_MANTISSA_BITS = 53;

const F64_SCRATCH = new DataView(new ArrayBuffer(8));

/** Decompose a double into `m * 2^e` with `0.5 <= |m| < 1`. */
function frexp(value: number): Floatexp {
  if (value === 0) return FLOATEXP_ZERO;
  if (!Number.isFinite(value)) {
    throw new Error(`Floatexp: non-finite value (${value})`);
  }

  F64_SCRATCH.setFloat64(0, value);
  const hi = F64_SCRATCH.getUint32(0);
  const exponentBits = (hi >>> 20) & 0x7ff;

  if (exponentBits === 0) {
    // Subnormal input: rescale by a power of two (exact) into the normal range,
    // then correct the exponent.
    const scaled = frexp(value * 2 ** 54);
    return { m: scaled.m, e: scaled.e - 54 };
  }

  const negative = hi >>> 31 === 1;
  // Clear sign and exponent, force the exponent to 0-bias: leaves positive
  // `1.f` in [1,2). The mask must drop the sign bit, or `-x` becomes `+x`.
  F64_SCRATCH.setUint32(0, (hi & 0x000fffff) | (1023 << 20));
  const unit = F64_SCRATCH.getFloat64(0);
  return { m: (negative ? -unit : unit) / 2, e: exponentBits - 1022 };
}

/** Build a normalised floatexp from any `m * 2^e`. */
export function normalize(mantissa: number, exponent: number): Floatexp {
  if (!Number.isSafeInteger(exponent)) {
    throw new Error(
      `Floatexp.normalize: exponent must be a safe integer (got ${exponent})`,
    );
  }
  const scaled = frexp(mantissa);
  if (scaled.m === 0) return FLOATEXP_ZERO;
  const e = scaled.e + exponent;
  if (!Number.isSafeInteger(e)) {
    throw new Error(
      `Floatexp.normalize: exponent overflow (${scaled.e} + ${exponent})`,
    );
  }
  return { m: scaled.m, e };
}

export function fromFloat(value: number): Floatexp {
  return normalize(value, 0);
}

/**
 * Lossy projection to a double. Values below the double range underflow to `0`
 * and values above it saturate to `Infinity` — deliberate, documented
 * projections for display and comparison, never used to carry scale.
 *
 * The exponent is applied in two halves because `2 ** 1024` is already
 * `Infinity`: a single-step projection would report saturated values for finite
 * ones such as `Number.MAX_VALUE`. Each half-scaling is exact (a power of two),
 * and no intermediate can overflow while the true result is finite, nor
 * underflow while it is non-zero.
 */
export function toFloat(a: Floatexp): number {
  if (a.m === 0) return 0;
  const half = a.e >> 1;
  return a.m * 2 ** half * 2 ** (a.e - half);
}

/** Convert a fixed-point value, keeping all 53 significant bits and the scale. */
export function fromBigFixed(a: BigFixed): Floatexp {
  const { bits, exponent } = topBits(a, FLOATEXP_MANTISSA_BITS);
  const signed = a.v < 0n ? -Number(bits) : Number(bits);
  return normalize(signed, exponent);
}

export function isZero(a: Floatexp): boolean {
  return a.m === 0;
}

export function equals(a: Floatexp, b: Floatexp): boolean {
  return a.m === b.m && a.e === b.e;
}

export function neg(a: Floatexp): Floatexp {
  return a.m === 0 ? FLOATEXP_ZERO : { m: -a.m, e: a.e };
}

export function abs(a: Floatexp): Floatexp {
  return a.m < 0 ? { m: -a.m, e: a.e } : a;
}

export function mul(a: Floatexp, b: Floatexp): Floatexp {
  if (a.m === 0 || b.m === 0) return FLOATEXP_ZERO;
  return normalize(a.m * b.m, a.e + b.e);
}

/**
 * Sum, aligning exponents in double precision.
 *
 * A very large exponent difference makes the smaller addend underflow into the
 * larger one — the same loss any floating-point addition has, and the reason
 * perturbative engines care about `|Z_n|` at all.
 */
export function add(a: Floatexp, b: Floatexp): Floatexp {
  if (a.m === 0) return b;
  if (b.m === 0) return a;
  const e = Math.max(a.e, b.e);
  const sum = a.m * 2 ** (a.e - e) + b.m * 2 ** (b.e - e);
  return normalize(sum, e);
}

export function sub(a: Floatexp, b: Floatexp): Floatexp {
  return add(a, neg(b));
}

function magnitudeCmp(a: Floatexp, b: Floatexp): -1 | 0 | 1 {
  const am = Math.abs(a.m);
  const bm = Math.abs(b.m);
  if (am === 0 && bm === 0) return 0;
  if (am === 0) return -1;
  if (bm === 0) return 1;
  if (a.e !== b.e) return a.e < b.e ? -1 : 1;
  if (am === bm) return 0;
  return am < bm ? -1 : 1;
}

/**
 * Total order over normalized floatexps.
 *
 * Comparing exponents before mantissas — rather than projecting both operands
 * to doubles — is what keeps this exact far outside the double range, which is
 * the common case once a delta has grown larger than a reference value that
 * passed near zero.
 */
export function cmp(a: Floatexp, b: Floatexp): -1 | 0 | 1 {
  const aNegative = a.m < 0;
  const bNegative = b.m < 0;
  if (aNegative !== bNegative) return aNegative ? -1 : 1;
  const magnitude = magnitudeCmp(a, b);
  if (!aNegative || magnitude === 0) return magnitude;
  return magnitude === 1 ? -1 : 1;
}

export function div(a: Floatexp, b: Floatexp): Floatexp {
  if (b.m === 0) {
    throw new Error("Floatexp.div: division by zero");
  }
  if (a.m === 0) return FLOATEXP_ZERO;
  return normalize(a.m / b.m, a.e - b.e);
}

/**
 * Square root, keeping the scale.
 *
 * The exponent is forced even before the mantissa is rooted, because a
 * half-integer exponent is not representable — and at these magnitudes the
 * value is usually far outside the double range, so a float fallback would
 * simply lose it.
 */
export function sqrt(a: Floatexp): Floatexp {
  if (a.m === 0) return FLOATEXP_ZERO;
  if (a.m < 0) {
    throw new Error(`Floatexp.sqrt: negative operand (${a.m})`);
  }
  const oddExponent = a.e % 2 !== 0;
  const mantissa = oddExponent ? a.m * 2 : a.m;
  const exponent = oddExponent ? a.e - 1 : a.e;
  return normalize(Math.sqrt(mantissa), exponent / 2);
}
