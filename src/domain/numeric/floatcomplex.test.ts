import { describe, expect, it } from "vitest";
import { fromFloat, normalize, equals, toFloat } from "./floatexp";
import {
  abs2FloatComplex,
  addFloatComplex,
  floatComplex,
  mulFloatComplex,
  subFloatComplex,
} from "./floatcomplex";

const fc = (re: number, im: number) => floatComplex(fromFloat(re), fromFloat(im));

describe("FloatComplex arithmetic", () => {
  it("multiplies correctly: (1+2i)(3+4i) = -5+10i", () => {
    const product = mulFloatComplex(fc(1, 2), fc(3, 4));
    expect(product.re.m * 2 ** product.re.e).toBeCloseTo(-5, 12);
    expect(product.im.m * 2 ** product.im.e).toBeCloseTo(10, 12);
  });

  it("multiplies i by i to -1", () => {
    const product = mulFloatComplex(fc(0, 1), fc(0, 1));
    expect(product.re.m * 2 ** product.re.e).toBeCloseTo(-1, 12);
    expect(product.im.m * 2 ** product.im.e).toBeCloseTo(0, 12);
  });

  it("computes |3+4i|^2 = 25", () => {
    const value = abs2FloatComplex(fc(3, 4));
    expect(value.m * 2 ** value.e).toBeCloseTo(25, 12);
  });

  it("adds and subtracts componentwise", () => {
    const sum = addFloatComplex(fc(0.5, -1.25), fc(0.25, 2));
    expect(sum.re.m * 2 ** sum.re.e).toBeCloseTo(0.75, 12);
    expect(sum.im.m * 2 ** sum.im.e).toBeCloseTo(0.75, 12);

    const difference = subFloatComplex(fc(0.5, -1.25), fc(0.25, 2));
    expect(difference.re.m * 2 ** difference.re.e).toBeCloseTo(0.25, 12);
    expect(difference.im.m * 2 ** difference.im.e).toBeCloseTo(-3.25, 12);
  });

  it("keeps working when components leave the double range", () => {
    // re = 2^-601, im = 2^-602 — both fine as doubles, their squares are not.
    const tiny = floatComplex(normalize(0.5, -600), normalize(0.25, -600));

    // |tiny|^2 = 2^-1202 + 2^-1204 = 0.625 * 2^-1201
    const magnitude = abs2FloatComplex(tiny);
    expect(equals(magnitude, normalize(0.625, -1201))).toBe(true);

    // (t + ui)^2 = (t^2 - u^2) + 2tui = 3*2^-1204 + 2^-1202 i
    const squared = mulFloatComplex(tiny, tiny);
    expect(equals(squared.re, normalize(0.75, -1202))).toBe(true);
    expect(equals(squared.im, normalize(0.5, -1201))).toBe(true);

    // ...and none of it is representable as a double.
    expect(toFloat(magnitude)).toBe(0);
    expect(toFloat(squared.im)).toBe(0);
  });
});
