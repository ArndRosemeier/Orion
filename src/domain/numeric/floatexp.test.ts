import { describe, expect, it } from "vitest";
import {
  FLOATEXP_ZERO,
  type Floatexp,
  abs,
  add,
  equals,
  fromBigFixed,
  fromFloat,
  isZero,
  mul,
  neg,
  normalize,
  sub,
  toFloat,
} from "./floatexp";

function expectNormalized(a: Floatexp): void {
  if (a.m === 0) {
    expect(a.e).toBe(0);
    return;
  }
  const magnitude = Math.abs(a.m);
  expect(magnitude).toBeGreaterThanOrEqual(0.5);
  expect(magnitude).toBeLessThan(1);
  expect(Number.isInteger(a.e)).toBe(true);
}

describe("Floatexp normalisation invariant", () => {
  it("holds for a spread of magnitudes", () => {
    for (const value of [1, -1, 0.25, 2, 1.75, -1.75, 1e300, 1e-300, 5e-324]) {
      expectNormalized(fromFloat(value));
    }
  });

  it("canonicalises zero", () => {
    expect(fromFloat(0)).toEqual(FLOATEXP_ZERO);
    expect(normalize(0, 12345)).toEqual(FLOATEXP_ZERO);
    expect(isZero(fromFloat(-0))).toBe(true);
  });

  it("decomposes exactly into mantissa and exponent", () => {
    expect(fromFloat(1)).toEqual({ m: 0.5, e: 1 });
    expect(fromFloat(2)).toEqual({ m: 0.5, e: 2 });
    expect(fromFloat(0.25)).toEqual({ m: 0.5, e: -1 });
    expect(fromFloat(-1.75)).toEqual({ m: -0.875, e: 1 });
  });

  it("rejects non-finite input and fractional exponents loudly", () => {
    expect(() => fromFloat(Number.NaN)).toThrow(/non-finite/);
    expect(() => fromFloat(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => normalize(0.5, 1.5)).toThrow(/safe integer/);
  });
});

describe("Floatexp round-trips doubles exactly", () => {
  it("is exact across the whole double range, subnormals included", () => {
    const values = [
      1,
      -1,
      0.1,
      1 / 3,
      Math.PI,
      1e-300,
      1e300,
      Number.MIN_VALUE,
      5e-324,
      Number.MAX_VALUE,
    ];
    for (const value of values) {
      expect(toFloat(fromFloat(value))).toBe(value);
    }
  });

  it("is exact for random doubles", () => {
    let seed = 987654321;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 500; i++) {
      const value = (next() - 0.5) * 2 ** Math.floor(next() * 600 - 300);
      expect(toFloat(fromFloat(value))).toBe(value);
    }
  });
});

describe("Floatexp arithmetic agrees with doubles inside the double range", () => {
  it("matches double addition and multiplication", () => {
    let seed = 24680;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 300; i++) {
      const a = (next() - 0.5) * 4;
      const b = (next() - 0.5) * 4;
      expect(toFloat(add(fromFloat(a), fromFloat(b)))).toBeCloseTo(a + b, 12);
      expect(toFloat(mul(fromFloat(a), fromFloat(b)))).toBeCloseTo(a * b, 12);
    }
  });

  it("subtracts and negates exactly on dyadic values", () => {
    expect(toFloat(sub(fromFloat(0.5), fromFloat(0.75)))).toBe(-0.25);
    expect(toFloat(neg(fromFloat(0.25)))).toBe(-0.25);
    expect(toFloat(abs(fromFloat(-0.25)))).toBe(0.25);
  });

  it("collapses cancellation to canonical zero", () => {
    expect(equals(sub(fromFloat(3), fromFloat(3)), FLOATEXP_ZERO)).toBe(true);
  });
});

describe("Floatexp carries scale that doubles cannot", () => {
  it("survives squaring well below the double range", () => {
    // 2^-600 is a normal double; its square is 2^-1200, which is not.
    const tiny = fromFloat(2 ** -600);
    const squared = mul(tiny, tiny);
    expect(toFloat(squared)).toBe(0); // the double would have died here
    expect(squared.e).toBe(-1199); // the floatexp still carries it
    expect(equals(squared, normalize(0.5, -1199))).toBe(true);
  });

  it("carries a fixed-point value 2000 bits below the double range", () => {
    const tiny = fromBigFixed({ v: 1n, fracBits: 2000 });
    expect(toFloat(tiny)).toBe(0);
    expect(equals(tiny, normalize(0.5, -1999))).toBe(true);
  });

  it("keeps 53 significant bits at extreme exponents", () => {
    // (2^52 + 1) / 2^2000: the low bit is 1947 binary orders below anything a
    // double can represent, yet it must survive into the mantissa.
    const a = fromBigFixed({ v: (1n << 52n) + 1n, fracBits: 2000 });
    expect(a.m).toBe(0.5 + 2 ** -53);
    expect(a.e).toBe(-1947);
    expect(toFloat(a)).toBe(0);
  });

  it("documents the loss when exponents differ beyond the mantissa", () => {
    // 1 + 2^-60 is 1 as far as a 53-bit mantissa is concerned.
    expect(toFloat(add(fromFloat(1), fromFloat(2 ** -60)))).toBe(1);
  });

  it("survives an exponent gap wider than the double range", () => {
    // Alignment must happen at the *larger* exponent. Aligning at the smaller
    // one overflows the scaling factor to Infinity and the whole sum dies —
    // silently, unless it is pinned.
    const big = normalize(0.5, 1000);
    const small = normalize(0.5, -1000);
    expect(equals(add(big, small), big)).toBe(true);
    expect(equals(add(small, big), big)).toBe(true);
  });

  it("preserves sign when converting from fixed point", () => {
    const negative = fromBigFixed({ v: -(1n << 52n), fracBits: 2000 });
    expect(negative.m).toBe(-0.5);
    expect(negative.e).toBe(-1947);
  });

  it("saturates to Infinity above the double range", () => {
    expect(toFloat(normalize(0.5, 2000))).toBe(Number.POSITIVE_INFINITY);
  });
});
