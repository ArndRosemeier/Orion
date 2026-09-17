import { describe, expect, it } from "vitest";
import { add, cmp, fromFloat, mul, normalize, sub } from "./floatexp";

describe("Floatexp ordering", () => {
  it("orders against zero from both signs", () => {
    expect(cmp(fromFloat(0), fromFloat(0))).toBe(0);
    expect(cmp(fromFloat(-1), fromFloat(0))).toBe(-1);
    expect(cmp(fromFloat(0), fromFloat(1))).toBe(-1);
    expect(cmp(fromFloat(-1), fromFloat(1))).toBe(-1);
    expect(cmp(fromFloat(1), fromFloat(-1))).toBe(1);
  });

  it("orders across exponents without projecting to doubles", () => {
    // Both of these project to 0 as doubles; the order must still be exact.
    const tiny = normalize(0.5, -2000);
    const tinier = normalize(0.5, -3000);
    expect(cmp(tiny, tinier)).toBe(1);
    expect(cmp(tinier, tiny)).toBe(-1);
    expect(cmp(tiny, tiny)).toBe(0);

    const huge = normalize(0.5, 2000);
    expect(cmp(huge, tiny)).toBe(1);
    expect(cmp(tiny, huge)).toBe(-1);
  });

  it("compares mantissas when exponents match", () => {
    const a = { m: 0.5, e: 10 };
    const b = { m: 0.75, e: 10 };
    expect(cmp(a, b)).toBe(-1);
    expect(cmp(b, a)).toBe(1);
  });

  it("orders negatives by magnitude in reverse", () => {
    const small = fromFloat(-1);
    const large = fromFloat(-2);
    expect(cmp(small, large)).toBe(1);
    expect(cmp(large, small)).toBe(-1);
  });

  it("agrees with arithmetic", () => {
    const a = fromFloat(3);
    const b = fromFloat(-0.5);
    expect(cmp(add(a, b), fromFloat(2.5))).toBe(0);
    expect(cmp(sub(a, b), fromFloat(3.5))).toBe(0);
    expect(cmp(mul(a, b), fromFloat(-1.5))).toBe(0);
  });
});
