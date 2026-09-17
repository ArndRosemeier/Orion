import { describe, expect, it } from "vitest";
import { cmp, fromFloat, fromInt, toFloat, withFracBits } from "./bigfixed";

describe("BigFixed.withFracBits", () => {
  it("raises precision exactly", () => {
    const coarse = fromFloat(0.25, 8);
    const fine = withFracBits(coarse, 256);
    expect(fine.fracBits).toBe(256);
    expect(toFloat(fine)).toBe(0.25);
    expect(cmp(fine, fromFloat(0.25, 256))).toBe(0);
  });

  it("lowers precision with the one rounding rule", () => {
    // 0.1 at 8 fractional bits is 26/256; at 4 bits that is 1.625 steps, which
    // rounds half away from zero to 2/16 = 0.125.
    const coarse = fromFloat(0.1015625, 8);
    expect(coarse.v).toBe(26n);
    const lower = withFracBits(coarse, 4);
    expect(lower.fracBits).toBe(4);
    expect(lower.v).toBe(2n);
  });

  it("rounds halves away from zero, both signs", () => {
    // 0.5 at 1 fractional bit is exactly half of one step at 0 bits: ties up.
    expect(withFracBits(fromFloat(0.5, 1), 0).v).toBe(1n);
    expect(withFracBits(fromFloat(-0.5, 1), 0).v).toBe(-1n);
  });

  it("is a no-op at the same precision", () => {
    const value = fromInt(7, 64);
    expect(withFracBits(value, 64)).toBe(value);
  });

  it("round-trips through a higher precision unchanged", () => {
    const value = fromFloat(-0.7436438870371587, 128);
    expect(cmp(withFracBits(withFracBits(value, 512), 128), value)).toBe(0);
  });

  it("rejects a negative or fractional target precision", () => {
    expect(() => withFracBits(fromFloat(1, 8), -1)).toThrow(/non-negative integer/);
    expect(() => withFracBits(fromFloat(1, 8), 4.5)).toThrow(/non-negative integer/);
  });
});
