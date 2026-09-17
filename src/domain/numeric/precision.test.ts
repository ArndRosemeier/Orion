import { describe, expect, it } from "vitest";
import {
  GUARD_BITS,
  MIN_FRAC_BITS,
  fracBitsForPixelSize,
  fracBitsForScaleExponent,
} from "./precision";

describe("fracBitsForScaleExponent", () => {
  it("buys exactly one bit of precision per bit of zoom", () => {
    expect(fracBitsForScaleExponent(-1000)).toBe(1000 + GUARD_BITS);
    expect(fracBitsForScaleExponent(-200)).toBe(200 + GUARD_BITS);
  });

  it("never drops below the floor precision at shallow scales", () => {
    expect(fracBitsForScaleExponent(0)).toBe(MIN_FRAC_BITS);
    expect(fracBitsForScaleExponent(-2)).toBe(MIN_FRAC_BITS);
    expect(fracBitsForScaleExponent(10)).toBe(MIN_FRAC_BITS);
  });

  it("is monotonic: deeper never needs fewer bits", () => {
    const depths = [0, -10, -64, -200, -1000, -5000, -100000];
    for (let i = 1; i < depths.length; i++) {
      const shallower = fracBitsForScaleExponent(depths[i - 1] as number);
      const deeper = fracBitsForScaleExponent(depths[i] as number);
      expect(deeper).toBeGreaterThanOrEqual(shallower);
    }
  });

  it("rounds up for fractional exponents instead of producing fractional bits", () => {
    expect(fracBitsForScaleExponent(-100.5)).toBe(GUARD_BITS + 101);
    expect(Number.isInteger(fracBitsForScaleExponent(-100.25))).toBe(true);
  });

  it("rejects non-finite exponents loudly", () => {
    expect(() => fracBitsForScaleExponent(Number.NaN)).toThrow(/finite/);
    expect(() => fracBitsForScaleExponent(Number.NEGATIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("fracBitsForPixelSize", () => {
  it("matches the exponent form for exact powers of two", () => {
    // 2^-1000 needs 1000 + GUARD_BITS fractional bits.
    expect(fracBitsForPixelSize({ v: 1n, fracBits: 1000 })).toBe(1000 + GUARD_BITS);
  });

  it("uses the exact floor of the exponent for non-powers of two", () => {
    // 3 * 2^-1000 lies in [2^-999, 2^-998), so it needs 999 + GUARD_BITS bits —
    // one fewer than 2^-1000. Deriving this from a float round-trip would lose
    // the distinction entirely.
    expect(fracBitsForPixelSize({ v: 3n, fracBits: 1000 })).toBe(999 + GUARD_BITS);
  });

  it("throws on a zero pixel size rather than inventing a precision", () => {
    expect(() => fracBitsForPixelSize({ v: 0n, fracBits: 128 })).toThrow(
      /zero has no logarithm/,
    );
  });
});
