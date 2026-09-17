import { describe, expect, it } from "vitest";
import { type BigComplex, bigComplex, subComplex } from "../numeric/bigcomplex";
import { add, fromDecimal, fromFloat } from "../numeric/bigfixed";
import { makeView, pixelToComplex } from "../view/view";
import { fromFloat as floatexpFromFloat } from "../numeric/floatexp";
import { escapeDirect } from "./direct";
import { escapePerturbed, escapeWithRepair, isGlitched } from "./perturbation";
import { computeReferenceOrbit } from "./reference";

const F = 256;
const FAMOUS_RE = "-0.743643887037158704752191506114774";
const FAMOUS_IM = "0.131825904205311970493132056385139";

type SurveySpec = {
  label: string;
  /** Where the view is centred. */
  viewCenter: BigComplex;
  /** Where the reference orbit is anchored — deliberately allowed to differ. */
  referenceCenter: BigComplex;
  widthExponent: number;
  grid: number;
  maxIterations: number;
  /** Truncate the orbit to this many values, to force early exhaustion. */
  orbitIterations?: number;
};

type Counts = {
  pixels: number;
  escaped: number;
  precisionGlitches: number;
  exhaustedGlitches: number;
  repaired: number;
  repairedMismatch: number;
  undetected: number;
  maxSmoothDelta: number;
};

/**
 * Render a grid two ways — perturbation and direct — and compare every pixel.
 *
 * `undetected` is the safety property: a pixel the engine did *not* flag as
 * glitched that still disagrees with the oracle. That is the failure a deep
 * renderer can never be allowed to have, because it produces a plausible wrong
 * image rather than an error.
 */
function survey(spec: SurveySpec): Counts {
  const view = makeView(
    spec.viewCenter,
    fromFloat(2 ** spec.widthExponent, F),
    spec.grid,
    spec.grid,
  );
  const orbit = computeReferenceOrbit(
    spec.referenceCenter,
    spec.orbitIterations ?? spec.maxIterations + 1,
  );

  const counts: Counts = {
    pixels: 0,
    escaped: 0,
    precisionGlitches: 0,
    exhaustedGlitches: 0,
    repaired: 0,
    repairedMismatch: 0,
    undetected: 0,
    maxSmoothDelta: 0,
  };

  for (let py = 0; py < spec.grid; py++) {
    for (let px = 0; px < spec.grid; px++) {
      const c = pixelToComplex(view, px, py);
      const offset = subComplex(c, spec.referenceCenter);
      const oracle = escapeDirect(c, spec.maxIterations);
      const naive = escapePerturbed(orbit, offset, spec.maxIterations);
      const repaired = escapeWithRepair(orbit, offset, spec.maxIterations);

      counts.pixels++;
      if (oracle.escaped) counts.escaped++;
      if (repaired.engine === "direct-repair") counts.repaired++;

      if (naive.glitched) {
        if (naive.reason === "precision") counts.precisionGlitches++;
        else counts.exhaustedGlitches++;
      } else {
        if (
          naive.escaped !== oracle.escaped ||
          naive.iterations !== oracle.iterations
        ) {
          counts.undetected++;
        } else if (
          naive.escaped &&
          oracle.escaped &&
          naive.smooth !== null &&
          oracle.smooth !== null
        ) {
          counts.maxSmoothDelta = Math.max(
            counts.maxSmoothDelta,
            Math.abs(naive.smooth - oracle.smooth),
          );
        }
      }

      if (
        repaired.escaped !== oracle.escaped ||
        repaired.iterations !== oracle.iterations
      ) {
        counts.repairedMismatch++;
      }
    }
  }
  return counts;
}

const famous = () => bigComplex(fromDecimal(FAMOUS_RE, F), fromDecimal(FAMOUS_IM, F));

describe("perturbation reproduces the direct oracle pixel for pixel", () => {
  it("on a deep escaping view where the reference itself escapes", () => {
    const center = bigComplex(fromDecimal("-0.743", F), fromDecimal("0.131", F));
    const counts = survey({
      label: "A",
      viewCenter: center,
      referenceCenter: center,
      widthExponent: -30,
      grid: 6,
      maxIterations: 900,
    });
    // Non-degenerate: this view really does escape.
    expect(counts.escaped).toBeGreaterThan(0);
    // Every pixel agrees, whether it was computed fast or repaired.
    expect(counts.undetected).toBe(0);
    expect(counts.repairedMismatch).toBe(0);
    // The reference escapes before some pixels do, so the exhaustion path
    // fires and repair carries those pixels.
    expect(counts.exhaustedGlitches).toBeGreaterThan(0);
    expect(counts.repaired).toBe(counts.exhaustedGlitches + counts.precisionGlitches);
  }, 60_000);

  it("on a long-orbit view at depth 2^-30", () => {
    const center = famous();
    const counts = survey({
      label: "C",
      viewCenter: center,
      referenceCenter: center,
      widthExponent: -30,
      grid: 6,
      maxIterations: 1600,
    });
    expect(counts.escaped).toBeGreaterThan(0);
    expect(counts.undetected).toBe(0);
    expect(counts.repairedMismatch).toBe(0);
    // The delta's accumulated error shows up only in the sub-iteration
    // smooth count, and only in the delta-dominated run-up to escape.
    // Measured worst case on this view is ~8e-6.
    expect(counts.maxSmoothDelta).toBeLessThan(1e-4);
  }, 120_000);

  it("on a still deeper view with even longer orbits", () => {
    const center = famous();
    const counts = survey({
      label: "D",
      viewCenter: center,
      referenceCenter: center,
      widthExponent: -35,
      grid: 4,
      maxIterations: 3000,
    });
    expect(counts.undetected).toBe(0);
    expect(counts.repairedMismatch).toBe(0);
    // Guard against a vacuous pass: some pixels really were escaped, and some
    // really were trusted to the perturbation path rather than repaired.
    expect(counts.escaped).toBeGreaterThan(0);
    expect(counts.pixels - counts.repaired).toBeGreaterThan(0);
  }, 180_000);

  it("on a view that is mostly inside the set", () => {
    const center = famous();
    const counts = survey({
      label: "B",
      viewCenter: center,
      referenceCenter: center,
      widthExponent: -20,
      grid: 6,
      maxIterations: 700,
    });
    expect(counts.undetected).toBe(0);
    expect(counts.repairedMismatch).toBe(0);
    // Not every pixel escapes here — the bounded path is exercised too.
    expect(counts.escaped).toBeLessThan(counts.pixels);
  }, 60_000);
});

describe("glitch detection and repair", () => {
  it("is a threshold on the cancellation ratio, and nothing weaker", () => {
    const fe = floatexpFromFloat;
    // A squared ratio of 2^-25 is inside the 2^-24 threshold...
    expect(isGlitched(fe(0.5 * 2 ** -25), fe(0.5))).toBe(true);
    // ...and 2^-23 is outside it. A rendered test cannot distinguish these from
    // a disabled threshold, because total cancellation fires under any positive
    // threshold; this is the pin that can.
    expect(isGlitched(fe(0.5 * 2 ** -23), fe(0.5))).toBe(false);
    expect(isGlitched(fe(1), fe(1))).toBe(false);
    // Total cancellation is always flagged.
    expect(isGlitched(fe(0), fe(1))).toBe(true);
    // A reference at zero cannot cancel, so nothing is flagged.
    expect(isGlitched(fe(1), fe(0))).toBe(false);
  });

  it("flags exactly the pixel whose orbit cancels, and repairs it", () => {
    // Reference sits 2^-30 away from the view centre, whose orbit passes that
    // close to zero. With an odd grid the centre pixel lands exactly on the
    // view centre, where z_2 = c^2 + c = 0 at c = -1 — a total cancellation
    // of `Z + d`, which is precisely what the criterion exists to catch.
    const minusOne = fromDecimal("-1", F);
    const counts = survey({
      label: "G",
      viewCenter: bigComplex(minusOne, fromDecimal("0", F)),
      referenceCenter: bigComplex(
        add(minusOne, fromFloat(2 ** -30, F)),
        fromDecimal("0", F),
      ),
      widthExponent: -38,
      grid: 7,
      maxIterations: 60,
    });
    expect(counts.precisionGlitches).toBe(1);
    expect(counts.exhaustedGlitches).toBe(0);
    expect(counts.repaired).toBe(1);
    expect(counts.repairedMismatch).toBe(0);
    // The other 48 pixels were trusted, and all 48 were right.
    expect(counts.undetected).toBe(0);
  }, 60_000);

  it("hands back an exhausted orbit instead of inventing values", () => {
    // A deliberately truncated orbit: five values, fifty iterations asked for.
    // The engine must refuse past the end rather than read zeros.
    const minusOne = fromDecimal("-1", F);
    const center = bigComplex(minusOne, fromDecimal("0", F));
    const counts = survey({
      label: "E",
      viewCenter: center,
      referenceCenter: center,
      widthExponent: -20,
      grid: 5,
      maxIterations: 50,
      orbitIterations: 5,
    });
    expect(counts.exhaustedGlitches).toBeGreaterThan(0);
    expect(counts.repairedMismatch).toBe(0);
    expect(counts.undetected).toBe(0);
  }, 60_000);

  it("reports which engine produced each result", () => {
    const center = famous();
    // The orbit must cover maxIterations + 1 values (Z_0 .. Z_maxIterations).
    const orbit = computeReferenceOrbit(center, 201);
    const view = makeView(center, fromFloat(2 ** -20, F), 2, 2);
    const offset = subComplex(pixelToComplex(view, 0, 0), center);
    expect(escapeWithRepair(orbit, offset, 200).engine).toBe("perturbation");
  });

  it("rejects an iteration budget or precision mismatch loudly", () => {
    const center = famous();
    const orbit = computeReferenceOrbit(center, 10);
    const offset = subComplex(center, center);
    expect(() => escapePerturbed(orbit, offset, 0)).toThrow(/positive integer/);
    expect(() =>
      escapePerturbed(orbit, bigComplex(fromFloat(0, 128), fromFloat(0, 128)), 5),
    ).toThrow(/precision mismatch/);
  });
});
