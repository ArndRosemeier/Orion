import { describe, expect, it } from "vitest";
import { bigComplex, subComplex } from "../numeric/bigcomplex";
import { fromDecimal, fromFloat } from "../numeric/bigfixed";
import {
  div as feDiv,
  fromBigFixed,
  fromFloat as feFromFloat,
  toFloat as feToFloat,
} from "../numeric/floatexp";
import {
  abs2FloatComplex,
  floatComplex,
  subFloatComplex,
} from "../numeric/floatcomplex";
import { makeView, pixelToComplex } from "../view/view";
import { escapeDirect } from "./direct";
import { exactDelta, escapePerturbed } from "./perturbation";
import {
  buildSeries,
  computeSeriesCoefficients,
  escapePerturbedWithSeries,
  evaluateCoefficientsAt,
  evaluateSeriesAt,
  sampleOffsets,
  selectSeriesSkip,
} from "./series";
import { computeReferenceOrbit } from "./reference";

const F = 256;
const FAMOUS_RE = "-0.743643887037158704752191506114774";
const FAMOUS_IM = "0.131825904205311970493132056385139";

const DEEP = { widthExponent: -30, maxIterations: 1600, grid: 6, order: 3 } as const;

let shared: {
  view: ReturnType<typeof makeView>;
  orbit: ReturnType<typeof computeReferenceOrbit>;
  series: ReturnType<typeof buildSeries>;
} | null = null;

function fixture() {
  if (shared === null) {
    const center = bigComplex(fromDecimal(FAMOUS_RE, F), fromDecimal(FAMOUS_IM, F));
    const view = makeView(
      center,
      fromFloat(2 ** DEEP.widthExponent, F),
      DEEP.grid,
      DEEP.grid,
    );
    const orbit = computeReferenceOrbit(center, DEEP.maxIterations + 1);
    const pixelSize = 2 ** DEEP.widthExponent / DEEP.grid;
    const maxOffset = feFromFloat(Math.hypot(DEEP.grid / 2, DEEP.grid / 2) * pixelSize);
    const series = buildSeries(orbit, DEEP.order, DEEP.maxIterations, maxOffset);
    shared = { view, orbit, series };
  }
  return shared;
}

function offsetAt(px: number, py: number) {
  const { view, orbit } = fixture();
  const c = pixelToComplex(view, px, py);
  return { c, offset: subComplex(c, orbit.center) };
}

describe("Series coefficients are the Taylor coefficients of the delta", () => {
  it("starts from a_{1,1} = 1, so the series at n = 1 is exactly dc", () => {
    const { orbit } = fixture();
    const coefficients = computeSeriesCoefficients(orbit, 3, 200);
    const { offset } = offsetAt(1, 0);
    const dc = floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im));
    const value = evaluateCoefficientsAt(coefficients, 1, dc);
    expect(feToFloat(abs2FloatComplex(subFloatComplex(value, dc)))).toBe(0);
  });

  it("reproduces the exact delta to ~1e-12 relative out to n = 400", () => {
    const { orbit } = fixture();
    const coefficients = computeSeriesCoefficients(orbit, 3, 400);
    const { offset } = offsetAt(1, 0);
    const dc = floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im));

    let worst = 0;
    for (const n of [2, 3, 5, 10, 20, 50, 100, 200, 300, 399]) {
      const truth = exactDelta(orbit, dc, n);
      const approx = evaluateCoefficientsAt(coefficients, n, dc);
      const error = abs2FloatComplex(subFloatComplex(truth, approx));
      const magnitude = abs2FloatComplex(truth);
      const relative = feToFloat(feDiv(error, magnitude));
      if (Number.isFinite(relative)) worst = Math.max(worst, relative);
    }
    // Measured worst case is ~1e-17; the pin is deliberately looser than the
    // measurement so it trips on a real regression, not on rounding noise.
    expect(worst).toBeLessThan(1e-12);
  }, 120_000);

  it("rejects an order below 1", () => {
    const { orbit } = fixture();
    expect(() => computeSeriesCoefficients(orbit, 0, 100)).toThrow(/positive integer/);
  });
});

describe("The skip point is validated, not extrapolated", () => {
  it("skips a substantial prefix on a deep view", () => {
    const { series } = fixture();
    expect(series.skipIterations).toBeGreaterThan(100);
  });

  /**
   * The property the whole module rests on: at the chosen skip point, the true
   * truncation error stays inside the advertised `errorBound` for *every* pixel
   * of the view, not merely for the offsets that were sampled.
   */
  it("advertises a bound that no pixel in the view exceeds", () => {
    const { orbit, series } = fixture();
    let worstRatio = 0;
    let violations = 0;
    for (let py = 0; py < DEEP.grid; py++) {
      for (let px = 0; px < DEEP.grid; px++) {
        const { offset } = offsetAt(px, py);
        const dc = floatComplex(fromBigFixed(offset.re), fromBigFixed(offset.im));
        const truth = exactDelta(orbit, dc, series.skipIterations);
        const approx = evaluateSeriesAt(series, dc);
        const actual = feToFloat(abs2FloatComplex(subFloatComplex(truth, approx)));
        const ratio = actual / feToFloat(series.errorBound);
        expect(Number.isFinite(ratio)).toBe(true);
        worstRatio = Math.max(worstRatio, ratio);
        if (ratio > 1) violations++;
      }
    }
    expect(violations).toBe(0);
    // The bound is conservative rather than tight; measured worst ratio ~0.23.
    expect(worstRatio).toBeLessThan(1);
  }, 180_000);

  it("stops at the first step the bound rejects", () => {
    const { orbit } = fixture();
    const coefficients = computeSeriesCoefficients(orbit, 3, 600);
    const generous = selectSeriesSkip(
      orbit,
      coefficients,
      sampleOffsets(feFromFloat(2 ** -30)),
    );
    const strict = selectSeriesSkip(
      orbit,
      coefficients,
      sampleOffsets(feFromFloat(2 ** -30)),
      feFromFloat(2 ** -50),
    );
    expect(strict.skipIterations).toBeLessThan(generous.skipIterations);
  }, 180_000);

  it("refuses to skip when no sample survives", () => {
    const { orbit } = fixture();
    const coefficients = computeSeriesCoefficients(orbit, 3, 50);
    // A single offset of magnitude 4 escapes on its first iteration, so nothing
    // survives to validate any step and the honest answer is "no skip". (A ring
    // would be wrong here: its inner radius survives, which is a legitimate, if
    // tiny, skip.)
    const validation = selectSeriesSkip(orbit, coefficients, [
      floatComplex(feFromFloat(4), feFromFloat(0)),
    ]);
    expect(validation.skipIterations).toBe(0);
    expect(validation.maxRelativeError).toBe(0);
  }, 60_000);

  it("rejects a non-positive maxOffset", () => {
    const { orbit } = fixture();
    expect(() => buildSeries(orbit, 3, 100, feFromFloat(0))).toThrow(/positive/);
  });
});

describe("Known limitation: the series path is an approximation", () => {
  /**
   * The exact perturbation path reproduces the oracle's escape counts exactly
   * (pinned in `perturbation.test.ts`). The series path does **not**, and this
   * test exists so that can never be forgotten or quietly assumed away.
   *
   * Seeding the recurrence from a truncated series is not the same computation
   * as iterating it from `d_1 = dc`: near the boundary the escape count is
   * sensitive to the seed, and a mistake in the seed changes which trajectory
   * the pixel follows. The coefficient mathematics is verified correct above
   * (~1e-17 relative), and the bound is never violated, so this is a property
   * of the *method*, not of an implementation bug.
   *
   * Measured on this view: 8 of 36 pixels differ from the oracle at the default
   * tolerance. Therefore the series path is **opt-in**, its `skipped` field
   * reports that an approximation was used, and the ladder must gate it. If a
   * future change reduces this to zero, that is a finding worth acting on —
   * update this pin and the ledger row together.
   */
  it("does not promise oracle-exact escape counts", () => {
    const { orbit, series } = fixture();
    let exactMismatches = 0;
    let seriesMismatches = 0;
    let seriesUsed = 0;

    for (let py = 0; py < DEEP.grid; py++) {
      for (let px = 0; px < DEEP.grid; px++) {
        const { c, offset } = offsetAt(px, py);
        const oracle = escapeDirect(c, DEEP.maxIterations);
        const exact = escapePerturbed(orbit, offset, DEEP.maxIterations);
        const withSeries = escapePerturbedWithSeries(
          orbit,
          series,
          offset,
          DEEP.maxIterations,
        );
        if (withSeries.skipped > 0) seriesUsed++;
        if (
          !exact.glitched &&
          (exact.escaped !== oracle.escaped || exact.iterations !== oracle.iterations)
        ) {
          exactMismatches++;
        }
        if (
          withSeries.escaped !== oracle.escaped ||
          withSeries.iterations !== oracle.iterations
        ) {
          seriesMismatches++;
        }
      }
    }

    // The baseline is exact: this is what makes the limitation below meaningful.
    expect(exactMismatches).toBe(0);
    // The accelerator is used everywhere and reports that it was used...
    expect(seriesUsed).toBe(DEEP.grid * DEEP.grid);
    // ...and disagrees on a minority of near-boundary pixels. Both bounds are
    // tripwires: a regression that makes it worse, and a change that makes it
    // better, should force a look at the ledger row rather than pass silently.
    expect(seriesMismatches).toBeGreaterThan(0);
    expect(seriesMismatches).toBeLessThanOrEqual(12);
  }, 180_000);
});
