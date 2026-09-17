import { describe, expect, it } from "vitest";
import { type BigComplex, bigComplex } from "../numeric/bigcomplex";
import {
  add,
  fromDecimal,
  fromFloat,
  fromInt,
  withFracBits,
} from "../numeric/bigfixed";
import {
  type Floatexp,
  abs as feAbs,
  cmp as feCmp,
  fromFloat as feFromFloat,
  mul as feMul,
  sub as feSub,
} from "../numeric/floatexp";
import { readFloatComplex } from "../numeric/floatexparray";
import {
  type ReferenceOrbit,
  ORBIT_CONVERGENCE_TOLERANCE,
  computeConvergedReferenceOrbit,
  computeReferenceOrbit,
} from "./reference";

const FAMOUS_RE = "-0.743643887037158704752191506114774";
const FAMOUS_IM = "0.131825904205311970493132056385139";

function famousAt(fracBits: number): BigComplex {
  return bigComplex(fromDecimal(FAMOUS_RE, fracBits), fromDecimal(FAMOUS_IM, fracBits));
}

function minusTwoPlusEpsilonAt(fracBits: number): BigComplex {
  return bigComplex(
    add(fromInt(-2, fracBits), { v: 1n << BigInt(fracBits - 200), fracBits }),
    fromInt(0, fracBits),
  );
}

function componentAgrees(a: Floatexp, b: Floatexp, tolerance: number): boolean {
  if (a.m === 0 || b.m === 0) return a.m === b.m;
  const toleranceFe = feFromFloat(tolerance);
  return feCmp(feAbs(feSub(a, b)), feMul(feAbs(b), toleranceFe)) <= 0;
}

function orbitAgrees(a: ReferenceOrbit, b: ReferenceOrbit, tolerance: number): boolean {
  if (a.length !== b.length) return false;
  for (let n = 0; n < a.length; n++) {
    const left = readFloatComplex(a, n);
    const right = readFloatComplex(b, n);
    if (!componentAgrees(left.re, right.re, tolerance)) return false;
    if (!componentAgrees(left.im, right.im, tolerance)) return false;
  }
  return true;
}

describe("computeConvergedReferenceOrbit verifies precision instead of guessing", () => {
  it("raises precision until two computations agree", () => {
    // -2 + 2^-200 sits where the dynamics amplify a deviation by ~4x per step,
    // so over 400 iterations a precision that merely looks adequate is not.
    const result = computeConvergedReferenceOrbit(minusTwoPlusEpsilonAt(512), 400, 512);
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.fracBits).toBeGreaterThan(512);
    expect(result.orbit.length).toBe(400);
  }, 120_000);

  it("returns an orbit that stays put when precision is raised further", () => {
    const result = computeConvergedReferenceOrbit(famousAt(256), 300, 160);
    const higher = computeReferenceOrbit(
      bigComplex(
        withFracBits(result.orbit.center.re, result.fracBits * 4),
        withFracBits(result.orbit.center.im, result.fracBits * 4),
      ),
      300,
    );
    // Stability, stated as the property that matters: recomputing with four
    // times the precision does not move the stored values beyond tolerance.
    expect(orbitAgrees(result.orbit, higher, ORBIT_CONVERGENCE_TOLERANCE)).toBe(true);
  }, 120_000);

  it("reports a precision at least as high as the one it was given", () => {
    const result = computeConvergedReferenceOrbit(famousAt(256), 100, 192);
    expect(result.fracBits).toBeGreaterThanOrEqual(192);
  }, 60_000);
});

describe("convergence criterion rejects what it should", () => {
  it("differs from an orbit whose starting precision lost the offset", () => {
    // At 64 bits the 2^-200 offset is not representable, so this is the orbit
    // of -2, pinned to its fixed point — exactly what the check must reject.
    const tooCoarse = computeReferenceOrbit(
      bigComplex(fromFloat(-2, 64), fromFloat(0, 64)),
      80,
    );
    const converged = computeConvergedReferenceOrbit(
      minusTwoPlusEpsilonAt(512),
      80,
      64,
    );

    let differs = false;
    for (let n = 0; n < converged.orbit.length; n++) {
      const a = readFloatComplex(tooCoarse, n);
      const b = readFloatComplex(converged.orbit, n);
      if (a.re.m !== b.re.m || a.re.e !== b.re.e) differs = true;
    }
    expect(differs).toBe(true);
  }, 60_000);

  it("stops at the first precision that converges", () => {
    const result = computeConvergedReferenceOrbit(famousAt(128), 120, 128);
    expect(result.fracBits).toBeLessThanOrEqual(512);
    expect(result.attempts).toBeLessThanOrEqual(2);
  }, 120_000);

  it("rejects a non-positive starting precision", () => {
    expect(() => computeConvergedReferenceOrbit(famousAt(128), 10, 0)).toThrow(
      /positive integer/,
    );
  });

  it("fails loudly rather than returning an under-precise orbit", () => {
    // A cap below the starting precision cannot converge, and must say so
    // instead of handing back something it could not verify.
    expect(() =>
      computeConvergedReferenceOrbit(minusTwoPlusEpsilonAt(512), 400, 512, 256),
    ).toThrow(/no convergence/);
  }, 60_000);

  it("documents its tolerance", () => {
    expect(ORBIT_CONVERGENCE_TOLERANCE).toBe(2 ** -50);
  });
});
