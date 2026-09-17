import { describe, expect, it } from "vitest";
import { bigComplex } from "../numeric/bigcomplex";
import { add, fromFloat, fromInt } from "../numeric/bigfixed";
import { toFloat as floatexpToFloat } from "../numeric/floatexp";
import { escapeDirect } from "./direct";
import { readFloatComplex } from "../numeric/floatexparray";
import { computeReferenceOrbit } from "./reference";

const F = 256;

function center(re: number, im: number, fracBits = F) {
  return bigComplex(fromFloat(re, fracBits), fromFloat(im, fracBits));
}

describe("computeReferenceOrbit reproduces known orbits exactly", () => {
  it("is identically zero for c = 0", () => {
    const orbit = computeReferenceOrbit(center(0, 0), 32);
    expect(orbit.length).toBe(32);
    expect(orbit.escapedAt).toBeNull();
    for (let n = 0; n < orbit.length; n++) {
      expect(floatexpToFloat(readFloatComplex(orbit, n).re)).toBe(0);
      expect(floatexpToFloat(readFloatComplex(orbit, n).im)).toBe(0);
    }
  });

  it("settles into the period-2 cycle for c = -1", () => {
    const orbit = computeReferenceOrbit(center(-1, 0), 8);
    const expected = [0, -1, 0, -1, 0, -1, 0, -1];
    for (let n = 0; n < expected.length; n++) {
      expect(floatexpToFloat(readFloatComplex(orbit, n).re)).toBe(expected[n]);
    }
    expect(orbit.escapedAt).toBeNull();
  });

  it("reproduces the exact dyadic orbit of c = -1.75", () => {
    const orbit = computeReferenceOrbit(center(-1.75, 0), 5);
    // dyadic, so 53-bit mantissas hold every value exactly
    const expected = [0, -1.75, 1.3125, -0.02734375, -1.7492523193359375];
    for (let n = 0; n < expected.length; n++) {
      expect(floatexpToFloat(readFloatComplex(orbit, n).re)).toBe(expected[n]);
    }
  });

  it("stays on the |z| = 2 boundary for c = -2", () => {
    const orbit = computeReferenceOrbit(center(-2, 0), 200);
    expect(orbit.escapedAt).toBeNull();
    expect(floatexpToFloat(readFloatComplex(orbit, 1).re)).toBe(-2);
    expect(floatexpToFloat(readFloatComplex(orbit, 199).re)).toBe(2);
  });
});

describe("the orbit agrees with the direct escape engine", () => {
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
    it(`matches the escape time at c = ${re}${im >= 0 ? "+" : ""}${im}i`, () => {
      const budget = 200;
      const direct = escapeDirect(center(re, im), budget);
      const orbit = computeReferenceOrbit(center(re, im), budget);
      if (direct.escaped) {
        expect(orbit.escapedAt).toBe(direct.iterations);
      } else {
        expect(orbit.escapedAt).toBeNull();
      }
    });
  }

  it("stops storing once the orbit escapes", () => {
    const orbit = computeReferenceOrbit(center(1, 0), 200);
    expect(orbit.escapedAt).toBe(3);
    expect(orbit.length).toBe(4);
    expect(orbit.reMantissa.length).toBe(4);
  });
});

describe("reference precision buys iterations", () => {
  // The nominal point is -2 + 2^-200: inside the set's real slice [-2, 0.25], so
  // it never escapes. But the orbit of z -> z^2 + c near the repelling fixed
  // point z = 2 amplifies deviations by ~4x per iteration, so the offset
  // becomes visible after a number of iterations proportional to the bits of
  // precision. That is the whole reason the ladder cannot pick one precision.
  const epsilon = { v: 1n << BigInt(512 - 200), fracBits: 512 };
  const highCenter = bigComplex(add(fromInt(-2, 512), epsilon), fromInt(0, 512));

  it("resolves an offset at 512 bits that 64 bits rounds away entirely", () => {
    const low = computeReferenceOrbit(center(-2, 0, 64), 400);
    const high = computeReferenceOrbit(highCenter, 400);

    // 64 bits: the offset is not representable, so this is literally the orbit
    // of -2, pinned to the fixed point forever.
    expect(floatexpToFloat(readFloatComplex(low, 399).re)).toBe(2);
    expect(low.escapedAt).toBeNull();

    // 512 bits: the same nominal point holds the fixed point for a while, then
    // departs once amplification has caught up with the offset.
    expect(floatexpToFloat(readFloatComplex(high, 50).re)).toBe(2);
    expect(floatexpToFloat(readFloatComplex(high, 150).re)).not.toBe(2);
    expect(high.escapedAt).toBeNull();
  });

  it("still stores only 53 significant bits, so the offset is invisible in Z_1", () => {
    // This is the design, not a defect. A 53-bit mantissa at magnitude 2 has a
    // step of 2^-52, so a 2^-200 offset cannot appear in the stored orbit. The
    // offset lives in the per-pixel delta `dc`, computed at full precision —
    // which is exactly why the orbit may be stored coarse while the zoom stays
    // exact. The comment in reference.ts calls out the failure mode of
    // forgetting this.
    const high = computeReferenceOrbit(highCenter, 200);
    expect(floatexpToFloat(readFloatComplex(high, 1).re)).toBe(-2);
    expect(high.center.re.v).toBe(add(fromInt(-2, 512), epsilon).v);
  });
});

describe("computeReferenceOrbit validates its inputs", () => {
  it("rejects a non-positive or fractional iteration budget", () => {
    expect(() => computeReferenceOrbit(center(0, 0), 0)).toThrow(/positive integer/);
    expect(() => computeReferenceOrbit(center(0, 0), 2.5)).toThrow(/positive integer/);
  });

  it("stores at least Z_0 for a budget of one", () => {
    const orbit = computeReferenceOrbit(center(-1, 0), 1);
    expect(orbit.length).toBe(1);
    expect(floatexpToFloat(readFloatComplex(orbit, 0).re)).toBe(0);
  });

  it("rejects an out-of-range index loudly", () => {
    const orbit = computeReferenceOrbit(center(-1, 0), 4);
    expect(() => readFloatComplex(orbit, -1).re).toThrow(/out of range/);
    expect(() => readFloatComplex(orbit, 4).re).toThrow(/out of range/);
    expect(() => readFloatComplex(orbit, 1.5).im).toThrow(/out of range/);
  });
});
