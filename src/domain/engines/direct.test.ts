import { describe, expect, it } from "vitest";
import { bigComplex } from "../numeric/bigcomplex";
import { fromFloat } from "../numeric/bigfixed";
import { escapeDirect } from "./direct";

function c(re: number, im: number, fracBits = 256) {
  return bigComplex(fromFloat(re, fracBits), fromFloat(im, fracBits));
}

const MAX_ITERATIONS = 500;

describe("escapeDirect matches known Mandelbrot escape times", () => {
  it("escapes c=1 after exactly 3 iterations", () => {
    const outcome = escapeDirect(c(1, 0), MAX_ITERATIONS);
    expect(outcome.escaped).toBe(true);
    expect(outcome.iterations).toBe(3);
  });

  it("escapes c=2 after exactly 2 iterations", () => {
    const outcome = escapeDirect(c(2, 0), MAX_ITERATIONS);
    expect(outcome.escaped).toBe(true);
    expect(outcome.iterations).toBe(2);
  });

  it("escapes c=-2.5 after exactly 1 iteration", () => {
    const outcome = escapeDirect(c(-2.5, 0), MAX_ITERATIONS);
    expect(outcome.escaped).toBe(true);
    expect(outcome.iterations).toBe(1);
  });
});

describe("escapeDirect agrees with known bounded points", () => {
  const bounded = [
    { re: 0, im: 0, why: "the origin is a fixed point" },
    { re: -1, im: 0, why: "period-2 cycle" },
    { re: 0.25, im: 0, why: "parabolic cusp of the main cardioid" },
    { re: -0.75, im: 0, why: "parabolic cusp of the period-3 bulb" },
    { re: -2, im: 0, why: "sits exactly on |z| = 2 forever" },
    { re: 1e-40, im: 0, why: "deep inside the main cardioid" },
  ];

  for (const point of bounded) {
    it(`stays bounded for c=${point.re} (${point.why})`, () => {
      const outcome = escapeDirect(c(point.re, point.im), MAX_ITERATIONS);
      expect(outcome.escaped).toBe(false);
      expect(outcome.smooth).toBeNull();
    });
  }
});

describe("escapeDirect continuous escape count", () => {
  it("agrees with the standard smooth formula for c=1", () => {
    // z escapes at n=3 with |z|=5, so mu = 3 + 1 - log2(log2 5).
    const outcome = escapeDirect(c(1, 0), MAX_ITERATIONS);
    expect(outcome.smooth).toBeCloseTo(2.7847, 3);
  });

  it("is strictly between the integer count and the next one", () => {
    for (const re of [-1.9, -1.5, -1.2, 0.3, 0.4, 0.5]) {
      const outcome = escapeDirect(c(re, 0.1), MAX_ITERATIONS);
      if (outcome.escaped && outcome.smooth !== null) {
        expect(outcome.smooth).toBeGreaterThan(outcome.iterations - 1);
        expect(outcome.smooth).toBeLessThanOrEqual(outcome.iterations + 1);
      }
    }
  });
});

describe("escapeDirect is precision-independent", () => {
  it("gives identical escape times at 128 and 1024 fractional bits", () => {
    const points: Array<[number, number]> = [
      [0.3, 0.5],
      [-1.2, 0.2],
      [-0.75, 0.11],
      [0.35, 0.35],
      [-1.75, 0],
      [0.28, 0.008],
    ];
    for (const [re, im] of points) {
      const coarse = escapeDirect(c(re, im, 128), MAX_ITERATIONS);
      const fine = escapeDirect(c(re, im, 1024), MAX_ITERATIONS);
      expect(fine.escaped).toBe(coarse.escaped);
      expect(fine.iterations).toBe(coarse.iterations);
    }
  });
});

describe("escapeDirect is self-consistent under a longer budget", () => {
  it("never changes an escape time when maxIterations grows", () => {
    const grid: Array<[number, number]> = [];
    for (let re = -2; re <= 0.5; re += 0.1) {
      for (let im = -1; im <= 1; im += 0.1) {
        grid.push([re, im]);
      }
    }

    let compared = 0;
    for (const [re, im] of grid) {
      const short = escapeDirect(c(re, im, 256), 200);
      if (!short.escaped) continue;
      const long = escapeDirect(c(re, im, 256), 2000);
      expect(long.escaped).toBe(true);
      expect(long.iterations).toBe(short.iterations);
      compared++;
    }

    // Guard against the pin silently degenerating into "compared nothing".
    expect(compared).toBeGreaterThan(50);
  });
});

describe("escapeDirect validates its inputs", () => {
  it("rejects a non-positive or fractional iteration budget", () => {
    expect(() => escapeDirect(c(0, 0), 0)).toThrow(/positive integer/);
    expect(() => escapeDirect(c(0, 0), 10.5)).toThrow(/positive integer/);
  });
});
