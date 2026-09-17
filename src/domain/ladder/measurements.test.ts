import { beforeEach, describe, expect, it } from "vitest";
import { bigComplex } from "../numeric/bigcomplex";
import { fromDecimal } from "../numeric/bigfixed";
import { planView } from "./plan";
import {
  MAX_MEASUREMENTS,
  clearMeasurements,
  measurementFor,
  recordMeasurement,
  viewMeasurementKey,
} from "./measurements";
import { makeView } from "../view/view";

/** A view at the given width, at a precision its own pixel grid can resolve. */
function view(width: string, pixelWidth = 960, pixelHeight = 640) {
  // Enough fractional bits for 960 pixels at this scale, plus slack: the guard
  // is `makeView`'s, and guessing it would make these pins about the guess.
  const digits = (width.split(".")[1] ?? "").length;
  const fracBits = 256 + Math.ceil(digits * 3.33);
  return makeView(
    bigComplex(fromDecimal("-0.75", fracBits), fromDecimal("0.1", fracBits)),
    fromDecimal(width, fracBits),
    pixelWidth,
    pixelHeight,
  );
}

beforeEach(() => {
  clearMeasurements();
});

describe("view measurements", () => {
  it("remembers what a render validated, per view shape", () => {
    const deep = view("0.000000000000000000000000000000000000000000000000000000000001");
    const key = viewMeasurementKey(deep, 600);
    expect(measurementFor(key)).toBeNull();

    recordMeasurement(key, { seriesSkip: 120 });
    expect(measurementFor(key)).toEqual({ seriesSkip: 120 });

    // A different budget is a different measurement, because the validated skip
    // depends on how long the orbit is.
    expect(measurementFor(viewMeasurementKey(deep, 300))).toBeNull();
    // And a different scale is, too.
    expect(measurementFor(viewMeasurementKey(view("0.5"), 600))).toBeNull();
  });

  it("shares a measurement between views that differ only in position", () => {
    // The *shape* of the work is what is measured: two nearby views at the same
    // scale do the same amount of it, and the cost model only needs that.
    const here = view("0.000000000000000000000000000000000000000000000001");
    const there = makeView(
      bigComplex(
        fromDecimal("-0.743643887037151", 512),
        fromDecimal("0.13182590420533", 512),
      ),
      fromDecimal("0.000000000000000000000000000000000000000000000001", 512),
      960,
      640,
    );
    const key = viewMeasurementKey(here, 600);
    expect(viewMeasurementKey(there, 600)).toBe(key);
  });

  it("keeps the newest measurements and drops the oldest", () => {
    for (let i = 0; i < MAX_MEASUREMENTS + 10; i++) {
      recordMeasurement(`key-${i}`, { seriesSkip: i });
    }
    expect(measurementFor("key-0")).toBeNull();
    expect(measurementFor(`key-${MAX_MEASUREMENTS + 9}`)).toEqual({
      seriesSkip: MAX_MEASUREMENTS + 9,
    });
  });

  it("refuses a measurement that is not a non-negative integer", () => {
    expect(() => recordMeasurement("k", { seriesSkip: -1 })).toThrow(/seriesSkip/);
    expect(() => recordMeasurement("k", { seriesSkip: 1.5 })).toThrow(/seriesSkip/);
  });
});

describe("the ladder prices what was measured", () => {
  it("chooses the series stage once a long skip is known, and not before", () => {
    const deep = view("0.0000000000000000000000000000000000000000000000000000000001");
    const request = {
      scaleExponent: -100,
      maxIterations: 600,
      pixelCount: 960 * 640,
      quality: "preview" as const,
    };

    // Nothing measured: the series is priced with a skip of zero, so the exact
    // perturbation path is cheaper and is chosen.
    const unmeasured = planView(request);
    expect(unmeasured.stage).toBe("perturbation");

    // A render measures a real skip, and the plan now prefers the series.
    recordMeasurement(viewMeasurementKey(deep, 600), { seriesSkip: 300 });
    const measured = planView({
      ...request,
      measuredSeriesSkip:
        measurementFor(viewMeasurementKey(deep, 600))?.seriesSkip ?? 0,
    });
    expect(measured.stage).toBe("perturbation-series");
    // And it is cheaper by the work it no longer does, not by assertion.
    expect(measured.estimatedWork).toBeLessThan(unmeasured.estimatedWork);
  });

  it("still refuses the series for exact quality whatever was measured", () => {
    const plan = planView({
      scaleExponent: -100,
      maxIterations: 600,
      pixelCount: 960 * 640,
      quality: "exact",
      measuredSeriesSkip: 500,
    });
    expect(plan.stage).toBe("perturbation");
  });
});
