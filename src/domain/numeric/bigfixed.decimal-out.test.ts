import { describe, expect, it } from "vitest";
import { cmp, fromDecimal, fromFloat, fromInt, toDecimalString } from "./bigfixed";

const F = 256;

describe("BigFixed.toDecimalString is exact, not rounded", () => {
  it("writes the exact expansion of dyadic values", () => {
    expect(toDecimalString(fromFloat(0.25, 8))).toBe("0.25");
    expect(toDecimalString(fromFloat(-1.75, 8))).toBe("-1.75");
    expect(toDecimalString(fromFloat(2, 8))).toBe("2");
    expect(toDecimalString(fromFloat(-2, 8))).toBe("-2");
    expect(toDecimalString(fromInt(0, 8))).toBe("0");
  });

  it("keeps every digit a dyadic rational actually has", () => {
    // 1/256 = 0.00390625, exactly.
    expect(toDecimalString({ v: 1n, fracBits: 8 })).toBe("0.00390625");
    // 26/256 = 0.1015625, the one-rule rounding of 0.1 at 8 bits.
    expect(toDecimalString(fromFloat(0.1, 8))).toBe("0.1015625");
  });

  it("round-trips through fromDecimal without losing a bit", () => {
    let seed = 987654321;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 200; i++) {
      const value = (next() - 0.5) * 8;
      const original = fromFloat(value, F);
      const text = toDecimalString(original);
      expect(cmp(fromDecimal(text, F), original)).toBe(0);
    }
  });

  it("round-trips a value whose expansion is far longer than a double", () => {
    const original = fromDecimal("-0.743643887037158704752191506114774", F);
    const text = toDecimalString(original);
    expect(text.startsWith("-0.7436438870371587")).toBe(true);
    expect(cmp(fromDecimal(text, F), original)).toBe(0);
  });

  it("round-trips across precisions when the text is re-read at that precision", () => {
    for (const fracBits of [8, 64, 128, 512]) {
      const original = fromInt(-12345, fracBits);
      expect(cmp(fromDecimal(toDecimalString(original), fracBits), original)).toBe(0);
    }
  });
});
