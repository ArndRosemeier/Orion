import { describe, expect, it } from "vitest";
import {
  abs,
  add,
  cmp,
  div,
  equals,
  floorLog2,
  fromFloat,
  fromInt,
  isZero,
  mul,
  neg,
  sub,
  toFloat,
} from "./bigfixed";

const F = 256;

describe("BigFixed exact construction from doubles", () => {
  it("represents dyadic values exactly at every sufficient working precision", () => {
    const dyadic = [0.25, -1.75, 2, 0.5, -0.125, 3, -2, 1.5];
    for (const fracBits of [8, 64, 256, 1024, 4096]) {
      for (const value of dyadic) {
        expect(toFloat(fromFloat(value, fracBits))).toBe(value);
      }
    }
  });

  it("keeps full double precision at 4096 fractional bits (no overflow path)", () => {
    // x * 2**4096 would be Infinity in doubles; the bit-decomposition path must
    // not go through that product.
    const value = 1.0000000000000002; // 1 + 2^-52, the tightest double step
    const roundTripped = toFloat(fromFloat(value, 4096));
    expect(roundTripped).toBe(value);
  });

  it("round-trips arbitrary doubles to within half an ulp at 256 bits", () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 500; i++) {
      const value = (next() - 0.5) * 8;
      const roundTripped = toFloat(fromFloat(value, 256));
      expect(Math.abs(roundTripped - value)).toBeLessThanOrEqual(
        Math.abs(value) * 2 ** -52 + Number.EPSILON,
      );
    }
  });

  it("rejects non-finite input loudly", () => {
    expect(() => fromFloat(Number.NaN, F)).toThrow(/non-finite/);
    expect(() => fromFloat(Number.POSITIVE_INFINITY, F)).toThrow(/non-finite/);
  });

  it("rejects an invalid fracBits loudly", () => {
    expect(() => fromInt(1, -1)).toThrow(/non-negative integer/);
    expect(() => fromFloat(1, 1.5)).toThrow(/non-negative integer/);
  });
});

describe("BigFixed rounding discipline", () => {
  it("rounds halves away from zero on a positive tie", () => {
    // 0.5 * 2^-8 scaled to 8 fractional bits is exactly 0.5 -> rounds up to 1.
    const half = fromFloat(0.5 * 2 ** -8, 8);
    expect(half.v).toBe(1n);
  });

  it("rounds halves away from zero on a negative tie", () => {
    const half = fromFloat(-0.5 * 2 ** -8, 8);
    expect(half.v).toBe(-1n);
  });

  it("drops values below half a step", () => {
    expect(isZero(fromFloat(2 ** -60, 8))).toBe(true);
  });

  it("rounds a dyadic value that needs more bits than are available", () => {
    // 0.25 needs 2 fractional bits; at 1 bit the exact value 0.5 is a tie and
    // rounds away from zero to 1/2.
    expect(toFloat(fromFloat(0.25, 1))).toBe(0.5);
    expect(toFloat(fromFloat(-0.25, 1))).toBe(-0.5);
  });

  it("keeps exact products exact", () => {
    expect(equals(mul(fromFloat(1.5, F), fromFloat(2, F)), fromFloat(3, F))).toBe(true);
    expect(equals(div(fromFloat(3, F), fromFloat(2, F)), fromFloat(1.5, F))).toBe(true);
  });

  it("rounds non-terminating division to the nearest representable value", () => {
    const third = div(fromFloat(1, F), fromFloat(3, F));
    expect(toFloat(third)).toBeCloseTo(1 / 3, 15);
    // ... and the rounded result is within half a step of the true value.
    const step = 2 ** -F;
    expect(Math.abs(toFloat(third) - 1 / 3)).toBeLessThanOrEqual(step);
  });

  // The rule is implemented once; these pins hold it at every call site that can
  // lose bits, so a future optimization to any one path cannot quietly diverge.
  it("rounds half away from zero when multiplying (positive tie)", () => {
    // 1.5 * 1.5 = 2.25 is exactly half way between 2.0 and 2.5 at half-steps.
    const product = mul(fromFloat(1.5, 1), fromFloat(1.5, 1));
    expect(product.v).toBe(5n);
    expect(toFloat(product)).toBe(2.5);
  });

  it("rounds half away from zero when multiplying (negative tie)", () => {
    const product = mul(fromFloat(-1.5, 1), fromFloat(1.5, 1));
    expect(product.v).toBe(-5n);
    expect(toFloat(product)).toBe(-2.5);
  });

  it("rounds half away from zero when dividing (positive tie)", () => {
    expect(div(fromInt(3, 0), fromInt(2, 0)).v).toBe(2n);
  });

  it("rounds half away from zero when dividing (negative tie)", () => {
    expect(div(fromInt(-3, 0), fromInt(2, 0)).v).toBe(-2n);
  });
});

describe("BigFixed refuses silent precision mixing", () => {
  it("throws when adding different precisions", () => {
    expect(() => add(fromFloat(1, 64), fromFloat(1, 128))).toThrow(
      /precision mismatch/,
    );
  });

  it("throws when multiplying different precisions", () => {
    expect(() => mul(fromFloat(1, 64), fromFloat(1, 128))).toThrow(
      /precision mismatch/,
    );
  });

  it("throws when comparing different precisions", () => {
    expect(() => cmp(fromFloat(1, 64), fromFloat(1, 128))).toThrow(
      /precision mismatch/,
    );
  });

  it("throws on division by zero", () => {
    expect(() => div(fromFloat(1, F), fromFloat(0, F))).toThrow(/division by zero/);
  });
});

describe("BigFixed basic algebra", () => {
  it("adds, subtracts and negates exactly", () => {
    expect(equals(add(fromFloat(0.5, F), fromFloat(0.25, F)), fromFloat(0.75, F))).toBe(
      true,
    );
    expect(
      equals(sub(fromFloat(0.5, F), fromFloat(0.75, F)), fromFloat(-0.25, F)),
    ).toBe(true);
    expect(equals(neg(fromFloat(0.25, F)), fromFloat(-0.25, F))).toBe(true);
    expect(equals(abs(fromFloat(-0.25, F)), fromFloat(0.25, F))).toBe(true);
  });

  it("orders values consistently with their bigints", () => {
    expect(cmp(fromFloat(-1, F), fromFloat(0, F))).toBe(-1);
    expect(cmp(fromFloat(0, F), fromFloat(0, F))).toBe(0);
    expect(cmp(fromFloat(1e-30, F), fromFloat(-1e-30, F))).toBe(1);
  });
});

describe("BigFixed.floorLog2 is exact beyond the double exponent range", () => {
  it("returns the exponent of powers of two", () => {
    expect(floorLog2(fromFloat(1, F))).toBe(0);
    expect(floorLog2(fromFloat(2, F))).toBe(1);
    expect(floorLog2(fromFloat(0.25, F))).toBe(-2);
    expect(floorLog2(fromFloat(-4, F))).toBe(2);
  });

  it("floors between powers of two", () => {
    expect(floorLog2(fromFloat(3, F))).toBe(1);
    expect(floorLog2(fromFloat(0.75, F))).toBe(-1);
  });

  it("stays exact far below the smallest double (2^-2000)", () => {
    const tiny = { v: 1n, fracBits: 2000 };
    expect(floorLog2(tiny)).toBe(-2000);
  });

  it("throws on zero rather than inventing a value", () => {
    expect(() => floorLog2(fromFloat(0, F))).toThrow(/zero has no logarithm/);
  });
});

describe("BigFixed.toFloat is a documented lossy projection", () => {
  it("underflows to zero below the double range", () => {
    expect(toFloat({ v: 1n, fracBits: 2000 })).toBe(0);
  });

  it("saturates to Infinity above the double range", () => {
    expect(toFloat(fromInt(1n << 2000n, 0))).toBe(Number.POSITIVE_INFINITY);
  });
});
