/**
 * What a render *measured*, kept where the next plan can see it.
 *
 * The ladder prices stages from a cost model, and two of those prices depend on
 * facts only a render can produce: how much of an orbit the series approximation
 * actually validated on this view, and how the BLA tables came out. Until now the
 * plan was told `measuredSeriesSkip` by nobody, so the series stage was priced
 * with a skip of zero and therefore never chosen — a ladder that could not select
 * its own middle rung.
 *
 * This is the seam that closes it: a backend records what it measured against a
 * view key, and the planner reads it on the next plan for the same view. It is
 * deliberately *not* a promise that the skip will be the same — it is a
 * measurement of this view, replaced every time the view is measured.
 *
 * Bounded, because a session can visit unboundedly many views; the oldest entry
 * is dropped when it fills.
 */

import { scaleExponentOf, type View } from "../view/view";

/** Measured facts about one view. */
export type ViewMeasurement = {
  /** Iterations the series approximation validated on the last render. */
  readonly seriesSkip: number;
};

/**
 * A key identifying a view for measurement purposes.
 *
 * Deliberately coarse: the scale, the canvas and the iteration budget decide
 * both the cost model and the series validation, and including the exact centre
 * would mean two views a pixel apart share nothing. Two views that differ only
 * in their centre therefore share a measurement, which is the intent — the
 * *shape* of the work is what is being measured.
 */
export function viewMeasurementKey(view: View, maxIterations: number): string {
  return `${scaleExponentOf(view)}|${view.pixelWidth}x${view.pixelHeight}|${maxIterations}`;
}

/** How many views are remembered. Enough to cover a session of panning. */
export const MAX_MEASUREMENTS = 64;

const measurements = new Map<string, ViewMeasurement>();

/** Record what a render measured. */
export function recordMeasurement(key: string, measurement: ViewMeasurement): void {
  if (!Number.isInteger(measurement.seriesSkip) || measurement.seriesSkip < 0) {
    throw new Error(
      `measurement: seriesSkip must be a non-negative integer (got ${measurement.seriesSkip})`,
    );
  }
  // Re-inserting moves the key to the newest position, so the oldest is evicted
  // first.
  measurements.delete(key);
  measurements.set(key, measurement);
  while (measurements.size > MAX_MEASUREMENTS) {
    const oldest = measurements.keys().next();
    if (oldest.done === true) break;
    measurements.delete(oldest.value);
  }
}

/** What was measured for this view, or `null` when nothing has been. */
export function measurementFor(key: string): ViewMeasurement | null {
  return measurements.get(key) ?? null;
}

/** Forget everything. Used by tests, and by nothing in the product. */
export function clearMeasurements(): void {
  measurements.clear();
}
