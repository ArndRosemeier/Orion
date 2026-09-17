/**
 * Arbitrary-precision complex arithmetic, built strictly on `bigfixed`.
 *
 * One representation, one precision: every component in a `BigComplex` shares
 * `fracBits`, and every operation refuses mixed precision rather than silently
 * rescaling.
 */

import { type BigFixed, add, isZero, mul, sub } from "./bigfixed";

export type BigComplex = {
  readonly re: BigFixed;
  readonly im: BigFixed;
};

function assertSamePrecision(a: BigComplex, b: BigComplex, op: string): void {
  const bits = [a.re.fracBits, a.im.fracBits, b.re.fracBits, b.im.fracBits];
  const first = bits[0];
  if (bits.some((value) => value !== first)) {
    throw new Error(
      `BigComplex.${op}: precision mismatch across components (${bits.join(", ")} fractional bits)`,
    );
  }
}

export function bigComplex(re: BigFixed, im: BigFixed): BigComplex {
  if (re.fracBits !== im.fracBits) {
    throw new Error(
      `BigComplex.construct: precision mismatch across components (${re.fracBits}, ${im.fracBits} fractional bits)`,
    );
  }
  return { re, im };
}

export function addComplex(a: BigComplex, b: BigComplex): BigComplex {
  assertSamePrecision(a, b, "add");
  return { re: add(a.re, b.re), im: add(a.im, b.im) };
}

export function subComplex(a: BigComplex, b: BigComplex): BigComplex {
  assertSamePrecision(a, b, "sub");
  return { re: sub(a.re, b.re), im: sub(a.im, b.im) };
}

/** (a + bi)(c + di) = (ac - bd) + (ad + bc)i */
export function mulComplex(a: BigComplex, b: BigComplex): BigComplex {
  assertSamePrecision(a, b, "mul");
  const ac = mul(a.re, b.re);
  const bd = mul(a.im, b.im);
  const ad = mul(a.re, b.im);
  const bc = mul(a.im, b.re);
  return { re: sub(ac, bd), im: add(ad, bc) };
}

/** |z|^2 = re^2 + im^2 — avoids the square root needed for |z|. */
export function abs2Complex(a: BigComplex): BigFixed {
  return add(mul(a.re, a.re), mul(a.im, a.im));
}

export function isZeroComplex(a: BigComplex): boolean {
  return isZero(a.re) && isZero(a.im);
}
