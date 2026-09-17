/**
 * Complex arithmetic over `Floatexp`, the pair the perturbation engine iterates.
 *
 * Mirrors `bigcomplex.ts` deliberately: same operations, same names, different
 * scalar. There is no precision invariant to enforce here — a floatexp carries
 * its own exponent, so any two values can be combined.
 */

import { type Floatexp, add, mul, sub } from "./floatexp";

export type FloatComplex = {
  readonly re: Floatexp;
  readonly im: Floatexp;
};

export function floatComplex(re: Floatexp, im: Floatexp): FloatComplex {
  return { re, im };
}

export function addFloatComplex(a: FloatComplex, b: FloatComplex): FloatComplex {
  return { re: add(a.re, b.re), im: add(a.im, b.im) };
}

export function subFloatComplex(a: FloatComplex, b: FloatComplex): FloatComplex {
  return { re: sub(a.re, b.re), im: sub(a.im, b.im) };
}

/** (a + bi)(c + di) = (ac - bd) + (ad + bc)i */
export function mulFloatComplex(a: FloatComplex, b: FloatComplex): FloatComplex {
  return {
    re: sub(mul(a.re, b.re), mul(a.im, b.im)),
    im: add(mul(a.re, b.im), mul(a.im, b.re)),
  };
}

/** |z|^2 = re^2 + im^2 */
export function abs2FloatComplex(a: FloatComplex): Floatexp {
  return add(mul(a.re, a.re), mul(a.im, a.im));
}
