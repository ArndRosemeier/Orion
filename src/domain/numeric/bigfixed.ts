/**
 * Arbitrary-precision fixed-point real arithmetic.
 *
 * A `BigFixed` is the exact rational value `v / 2^fracBits`. This is the
 * precision substrate of the deep-zoom ladder: `fracBits` is chosen per view
 * scale (see `precision.ts`), and everything downstream — reference orbits,
 * perturbation deltas, the verification oracle — is expressed in this type.
 *
 * ## Rounding discipline (one rule, everywhere)
 *
 * Exact results are exact. When a result cannot be represented, it is rounded
 * **half away from zero**. There is deliberately no second rounding mode:
 * mixed rounding modes are a silent precision leak.
 *
 * ## No silent rescaling
 *
 * Every binary operation requires both operands to share `fracBits` and throws
 * otherwise. Silently rescaling would hide precision loss at exactly the moment
 * it becomes fatal (AGENTS.md: no silent fallbacks).
 */

export type BigFixed = {
  readonly v: bigint;
  readonly fracBits: number;
};

function assertFracBits(fracBits: number, op: string): void {
  if (!Number.isInteger(fracBits) || fracBits < 0) {
    throw new Error(
      `BigFixed.${op}: fracBits must be a non-negative integer (got ${fracBits})`,
    );
  }
}

function assertSamePrecision(a: BigFixed, b: BigFixed, op: string): void {
  if (a.fracBits !== b.fracBits) {
    throw new Error(
      `BigFixed.${op}: precision mismatch (${a.fracBits} vs ${b.fracBits} fractional bits)`,
    );
  }
}

/** Number of significant bits in a non-negative bigint (0 -> 0). */
function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/**
 * THE rounding rule: divide and round halves **away from zero**.
 *
 * Every inexact `BigFixed` result routes through here — float construction,
 * multiplication, division and projection to double each express their loss as a
 * division by a power of two. There is deliberately no second implementation and
 * no second mode: two copies of a rounding rule drift, and a drifting rounding
 * rule is a silent precision leak. `1n << 0n` is `1n`, so exact cases need no
 * special path.
 */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n - quotient * d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Construct from an integer, exactly. */
export function fromInt(value: number | bigint, fracBits: number): BigFixed {
  assertFracBits(fracBits, "fromInt");
  const asBig = typeof value === "bigint" ? value : BigInt(value);
  return { v: asBig << BigInt(fracBits), fracBits };
}

/**
 * The exact decimal expansion of a `BigFixed`.
 *
 * Every fixed-point value is a dyadic rational, so its decimal expansion is
 * *finite* — which means this can be exact rather than rounded, and a coordinate
 * can survive a round trip through text without losing a bit.
 *
 * The fractional part is `n / 2^F` for integer `n`, and
 * `n / 2^F == n * 5^F / 10^F`, so the digits are literally `n * 5^F` written out
 * and left-padded to `F` places. That is one bigint multiplication rather than a
 * digit-at-a-time loop, and it is why the result never has a rounding error to
 * apologise for.
 */
export function toDecimalString(a: BigFixed): string {
  if (a.v === 0n) return "0";
  const negative = a.v < 0n;
  const magnitude = negative ? -a.v : a.v;
  const scale = 1n << BigInt(a.fracBits);
  const integerPart = magnitude / scale;
  const fractional = magnitude % scale;

  let text = integerPart.toString();
  if (fractional !== 0n) {
    const digits = (fractional * 5n ** BigInt(a.fracBits))
      .toString()
      .padStart(a.fracBits, "0")
      .replace(/0+$/, "");
    text += `.${digits}`;
  }
  return negative ? `-${text}` : text;
}

/**
 * Re-express a value at a different working precision.
 *
 * Raising precision is exact; lowering it rounds by the one rounding rule. The
 * ladder needs this to test whether a working precision has converged: compute
 * at `F` and at `2F` from the *same* input value, then compare — which is only
 * meaningful if the input did not itself change precision on the way in.
 */
export function withFracBits(a: BigFixed, fracBits: number): BigFixed {
  assertFracBits(fracBits, "withFracBits");
  if (fracBits === a.fracBits) return a;
  const shift = fracBits - a.fracBits;
  if (shift > 0) return { v: a.v << BigInt(shift), fracBits };
  const magnitude = a.v < 0n ? -a.v : a.v;
  const rounded = divideRounded(magnitude, 1n << BigInt(-shift));
  return { v: a.v < 0n ? -rounded : rounded, fracBits };
}

const F64_SCRATCH = new DataView(new ArrayBuffer(8));

/**
 * Construct from an IEEE-754 double, exactly where representable and otherwise
 * rounded half away from zero.
 *
 * Decomposed bit-for-bit rather than via `x * 2**fracBits`, because that
 * product overflows to `Infinity` once `fracBits > 1023` — precisely the deep
 * zoom range this type exists to serve.
 */
export function fromFloat(value: number, fracBits: number): BigFixed {
  assertFracBits(fracBits, "fromFloat");
  if (!Number.isFinite(value)) {
    throw new Error(`BigFixed.fromFloat: non-finite input (${value})`);
  }

  F64_SCRATCH.setFloat64(0, value);
  const hi = F64_SCRATCH.getUint32(0);
  const lo = F64_SCRATCH.getUint32(4);
  const negative = hi >>> 31 === 1;
  const expBits = (hi >>> 20) & 0x7ff;
  const mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);

  let significand: bigint;
  let exponent2: number;
  if (expBits === 0) {
    if (mantissa === 0n) return { v: 0n, fracBits };
    significand = mantissa;
    exponent2 = -1074;
  } else {
    significand = mantissa | (1n << 52n);
    exponent2 = expBits - 1075;
  }

  const shift = exponent2 + fracBits;
  const magnitude =
    shift >= 0
      ? significand << BigInt(shift)
      : divideRounded(significand, 1n << BigInt(-shift));

  return { v: negative ? -magnitude : magnitude, fracBits };
}

/**
 * Construct from a plain decimal string, e.g. `"-0.743643887037158704752191"`.
 *
 * Decimal is how deep-zoom coordinates actually arrive — shared URLs, saved
 * locations, published references — and a double cannot carry more than 53
 * bits of one. Parsing straight to fixed point keeps every digit the caller
 * wrote, up to the working precision, with the one rounding rule applied at the
 * end.
 *
 * Deliberately no exponent notation and no separators: a coordinate that is not
 * plain decimal is a caller error, not something to guess at.
 */
export function fromDecimal(text: string, fracBits: number): BigFixed {
  assertFracBits(fracBits, "fromDecimal");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) {
    throw new Error(`BigFixed.fromDecimal: not a plain decimal number (${text})`);
  }
  const sign = match[1] ?? "";
  const intPart = match[2] ?? "";
  const fracPart = match[3] ?? "";
  if (intPart === "" && fracPart === "") {
    throw new Error(`BigFixed.fromDecimal: no digits (${text})`);
  }

  const digits = BigInt(`${intPart === "" ? "0" : intPart}${fracPart}`);
  const scale = 10n ** BigInt(fracPart.length);
  const magnitude = divideRounded(digits << BigInt(fracBits), scale);
  return { v: sign === "-" ? -magnitude : magnitude, fracBits };
}

/**
 * Lossy projection to a double, for display, logging and oracle comparisons.
 *
 * Values below ~2^-1074 underflow to `0` and values above ~2^1024 saturate to
 * `Infinity`; both are deliberate, documented projections, not error paths.
 */
export function toFloat(a: BigFixed): number {
  if (a.v === 0n) return 0;
  const negative = a.v < 0n;
  const magnitude = negative ? -a.v : a.v;
  const drop = Math.max(bitLength(magnitude) - 53, 0);
  const mantissa =
    drop > 0 ? Number(divideRounded(magnitude, 1n << BigInt(drop))) : Number(magnitude);
  const value = mantissa * 2 ** (drop - a.fracBits);
  return negative ? -value : value;
}

export function add(a: BigFixed, b: BigFixed): BigFixed {
  assertSamePrecision(a, b, "add");
  return { v: a.v + b.v, fracBits: a.fracBits };
}

export function sub(a: BigFixed, b: BigFixed): BigFixed {
  assertSamePrecision(a, b, "sub");
  return { v: a.v - b.v, fracBits: a.fracBits };
}

export function neg(a: BigFixed): BigFixed {
  return { v: -a.v, fracBits: a.fracBits };
}

export function abs(a: BigFixed): BigFixed {
  return { v: a.v < 0n ? -a.v : a.v, fracBits: a.fracBits };
}

export function mul(a: BigFixed, b: BigFixed): BigFixed {
  assertSamePrecision(a, b, "mul");
  const product = a.v * b.v;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const rounded = divideRounded(magnitude, 1n << BigInt(a.fracBits));
  return { v: negative ? -rounded : rounded, fracBits: a.fracBits };
}

export function div(a: BigFixed, b: BigFixed): BigFixed {
  assertSamePrecision(a, b, "div");
  if (b.v === 0n) {
    throw new Error("BigFixed.div: division by zero");
  }
  const numerator = a.v << BigInt(a.fracBits);
  return { v: divideRounded(numerator, b.v), fracBits: a.fracBits };
}

export function cmp(a: BigFixed, b: BigFixed): -1 | 0 | 1 {
  assertSamePrecision(a, b, "cmp");
  if (a.v < b.v) return -1;
  if (a.v > b.v) return 1;
  return 0;
}

export function isZero(a: BigFixed): boolean {
  return a.v === 0n;
}

export function equals(a: BigFixed, b: BigFixed): boolean {
  return cmp(a, b) === 0;
}

/**
 * Exact `floor(log2(|value|))`, derived from the bit length rather than from a
 * float round-trip — so it stays correct far below the double exponent range.
 */
export function floorLog2(a: BigFixed): number {
  if (a.v === 0n) {
    throw new Error("BigFixed.floorLog2: zero has no logarithm");
  }
  const magnitude = a.v < 0n ? -a.v : a.v;
  return bitLength(magnitude) - 1 - a.fracBits;
}

export type TopBits = {
  /** Integer with up to `count` significant bits. */
  readonly bits: bigint;
  /** Binary exponent: `|value| ~= bits * 2^exponent`. */
  readonly exponent: number;
};

/**
 * The top `count` significant bits of `|value|`, plus the binary exponent that
 * puts them back where they belong.
 *
 * This is the bridge out of fixed point: the per-pixel engine needs a bounded
 * mantissa, but the *scale* of a reference orbit is unbounded, so the exponent
 * has to leave with it. Rounding uses the one rounding rule; nothing here can
 * underflow or overflow, because the exponent carries the scale.
 *
 * `bits` is normalised to exactly `count` bits except where rounding carries
 * (e.g. up to `2^count`), which callers renormalise.
 */
export function topBits(a: BigFixed, count: number): TopBits {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `BigFixed.topBits: count must be a positive integer (got ${count})`,
    );
  }
  if (a.v === 0n) return { bits: 0n, exponent: 0 };

  const magnitude = a.v < 0n ? -a.v : a.v;
  const drop = bitLength(magnitude) - count;
  const bits =
    drop >= 0
      ? divideRounded(magnitude, 1n << BigInt(drop))
      : magnitude << BigInt(-drop);
  return { bits, exponent: drop - a.fracBits };
}
