import { describe, expect, it } from "vitest";
import { bigComplex } from "../numeric/bigcomplex";
import { fromFloat } from "../numeric/bigfixed";
import { escapeDirect } from "./direct";
import { escapeDirectFloat } from "./directFloat";

const F = 256;

function c(re: number, im: number) {
  return bigComplex(fromFloat(re, F), fromFloat(im, F));
}

describe("escapeDirectFloat agrees with the arbitrary-precision oracle", () => {
  const points: Array<[number, number]> = [
    [1, 0],
    [2, 0],
    [-2.5, 0],
    [0, 0],
    [-1, 0],
    [0.25, 0],
    [-2, 0],
    [0.3, 0.5],
    [-1.2, 0.2],
    [0.35, 0.35],
    [-1.75, 0],
    [0.28, 0.008],
  ];

  for (const [re, im] of points) {
    it(`matches the escape count and smooth value at c = ${re}${im >= 0 ? "+" : ""}${im}i`, () => {
      const budget = 300;
      const oracle = escapeDirect(c(re, im), budget);
      const fast = escapeDirectFloat(re, im, budget);
      expect(fast.escaped).toBe(oracle.escaped);
      expect(fast.iterations).toBe(oracle.iterations);
      if (oracle.smooth !== null && fast.smooth !== null) {
        expect(fast.smooth).toBeCloseTo(oracle.smooth, 9);
      }
    });
  }

  it("matches over a deterministic grid of shallow points", () => {
    let compared = 0;
    let mismatches = 0;
    for (let re = -1.5; re <= 0.25; re += 0.05) {
      for (let im = -0.75; im <= 0.75; im += 0.05) {
        const oracle = escapeDirect(c(re, im), 200);
        const fast = escapeDirectFloat(re, im, 200);
        compared++;
        if (oracle.escaped !== fast.escaped || oracle.iterations !== fast.iterations) {
          mismatches++;
        }
      }
    }
    // A grid this coarse can still land within a rounding step of the escape
    // boundary at a handful of points; the ceiling is measured, not assumed.
    expect(compared).toBeGreaterThan(1000);
    expect(mismatches / compared).toBeLessThan(0.001);
  });
});

describe("escapeDirectFloat validates its inputs", () => {
  it("rejects a bad budget or a non-finite point", () => {
    expect(() => escapeDirectFloat(0, 0, 0)).toThrow(/positive integer/);
    expect(() => escapeDirectFloat(0, 0, 1.5)).toThrow(/positive integer/);
    expect(() => escapeDirectFloat(Number.NaN, 0, 10)).toThrow(/non-finite/);
    expect(() => escapeDirectFloat(0, Number.POSITIVE_INFINITY, 10)).toThrow(
      /non-finite/,
    );
  });
});
