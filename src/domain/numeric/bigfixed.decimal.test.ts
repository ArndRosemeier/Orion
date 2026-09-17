import { describe, expect, it } from "vitest";
import { cmp, fromDecimal, fromFloat, fromInt, isZero, toFloat } from "./bigfixed";

const F = 256;

describe("BigFixed.fromDecimal", () => {
  it("parses exactly where the decimal is dyadic", () => {
    expect(cmp(fromDecimal("0.25", F), fromFloat(0.25, F))).toBe(0);
    expect(cmp(fromDecimal("-1.75", F), fromFloat(-1.75, F))).toBe(0);
    expect(cmp(fromDecimal("0.5", F), fromFloat(0.5, F))).toBe(0);
    expect(cmp(fromDecimal("1", F), fromInt(1, F))).toBe(0);
    expect(cmp(fromDecimal("-2", F), fromInt(-2, F))).toBe(0);
  });

  it("accepts leading, trailing and missing integer parts", () => {
    expect(cmp(fromDecimal("+0.5", F), fromFloat(0.5, F))).toBe(0);
    expect(cmp(fromDecimal(".5", F), fromFloat(0.5, F))).toBe(0);
    expect(cmp(fromDecimal("0.500", F), fromFloat(0.5, F))).toBe(0);
    expect(cmp(fromDecimal("  0.25 ", F), fromFloat(0.25, F))).toBe(0);
    expect(isZero(fromDecimal("0.000", F))).toBe(true);
  });

  it("rounds non-dyadic decimals with the one rounding rule", () => {
    // 0.1 * 256 = 25.6 -> 26 -> 26/256.
    expect(toFloat(fromDecimal("0.1", 8))).toBe(26 / 256);
    // A tie: 0.5 * 256 + ... exercise half-away-from-zero at 8 bits.
    expect(toFloat(fromDecimal("0.001953125", 8))).toBe(1 / 256);
  });

  it("keeps precision far beyond a double", () => {
    // The classic deep-zoom coordinate. Parsed straight to fixed point it must
    // differ from the same digits routed through a double, or the 33rd digit
    // would be decoration.
    const decimal = "-0.743643887037158704752191506114774";
    const asDouble = fromFloat(Number(decimal), F);
    expect(cmp(fromDecimal(decimal, F), asDouble)).not.toBe(0);
  });

  it("preserves the sign of a long negative decimal", () => {
    const decimal = "-0.743643887037158704752191506114774";
    const parsed = fromDecimal(decimal, F);
    const positive = fromDecimal(decimal.slice(1), F);
    expect(parsed.v).toBe(-positive.v);
  });

  it("rejects malformed input rather than guessing", () => {
    expect(() => fromDecimal("", F)).toThrow(/no digits/);
    expect(() => fromDecimal("abc", F)).toThrow(/not a plain decimal/);
    expect(() => fromDecimal("1e-5", F)).toThrow(/not a plain decimal/);
    expect(() => fromDecimal("1,000", F)).toThrow(/not a plain decimal/);
    expect(() => fromDecimal(".", F)).toThrow(/no digits/);
    expect(() => fromDecimal("-", F)).toThrow(/no digits/);
  });
});
