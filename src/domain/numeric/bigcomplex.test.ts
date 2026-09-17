import { describe, expect, it } from "vitest";
import {
  abs2Complex,
  addComplex,
  bigComplex,
  isZeroComplex,
  mulComplex,
  subComplex,
} from "./bigcomplex";
import { fromFloat, toFloat } from "./bigfixed";

const F = 256;

function c(re: number, im: number, fracBits = F) {
  return bigComplex(fromFloat(re, fracBits), fromFloat(im, fracBits));
}

describe("BigComplex arithmetic", () => {
  it("multiplies correctly: (1+2i)(3+4i) = -5+10i", () => {
    const product = mulComplex(c(1, 2), c(3, 4));
    expect(toFloat(product.re)).toBe(-5);
    expect(toFloat(product.im)).toBe(10);
  });

  it("multiplies i by i to -1", () => {
    const product = mulComplex(c(0, 1), c(0, 1));
    expect(toFloat(product.re)).toBe(-1);
    expect(toFloat(product.im)).toBe(0);
  });

  it("computes |3+4i|^2 = 25 exactly", () => {
    expect(toFloat(abs2Complex(c(3, 4)))).toBe(25);
  });

  it("adds and subtracts componentwise", () => {
    const sum = addComplex(c(0.5, -1.25), c(0.25, 2));
    expect(toFloat(sum.re)).toBe(0.75);
    expect(toFloat(sum.im)).toBe(0.75);

    const difference = subComplex(c(0.5, -1.25), c(0.25, 2));
    expect(toFloat(difference.re)).toBe(0.25);
    expect(toFloat(difference.im)).toBe(-3.25);
  });

  it("recognises zero", () => {
    expect(isZeroComplex(c(0, 0))).toBe(true);
    expect(isZeroComplex(c(0, 1e-40))).toBe(false);
  });
});

describe("BigComplex refuses silent precision mixing", () => {
  it("throws when the two components disagree", () => {
    expect(() => bigComplex(fromFloat(1, 64), fromFloat(1, 128))).toThrow(
      /precision mismatch/,
    );
  });

  it("throws when operands disagree", () => {
    expect(() => mulComplex(c(1, 1, 64), c(1, 1, 128))).toThrow(/precision mismatch/);
  });
});
