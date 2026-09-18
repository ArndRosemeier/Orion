import { describe, expect, it } from "vitest";
import { passesFor } from "./passes";

/** How many tiles a pass is cut into, in sample space. */
function tileCount(
  pixelWidth: number,
  pixelHeight: number,
  step: number,
  samplesAcross: number,
): number {
  return (
    Math.ceil(Math.ceil(pixelWidth / step) / samplesAcross) *
    Math.ceil(Math.ceil(pixelHeight / step) / samplesAcross)
  );
}

describe("passesFor", () => {
  it("bounds the GPU coarse tile so its synchronous repair cannot stall the preview", () => {
    const passes = passesFor("gpu", 960, 640, 8);
    expect(passes.map((pass) => pass.name)).toEqual(["coarse", "full"]);
    const coarse = passes[0];
    expect(coarse?.step).toBe(8);
    // A flagged pixel is repaired on the CPU, synchronously and in proportion to
    // the tile's area, so the coarse tile is bounded. The old 1024 span made one
    // 1024x1024 tile that repaired 1,048,576 pixels (54.9s measured) before the
    // coarse could paint — the preview pass stalled behind the exact repair.
    expect(coarse?.samplesAcross).toBeLessThanOrEqual(128);
    expect(tileCount(960, 640, 8, coarse?.samplesAcross ?? 0)).toBeLessThanOrEqual(16);
  });

  it("gives the pool several waves of tiles on the coarse pass", () => {
    // The regression this exists for: one tile on the coarse pass means one
    // *worker* on the latency-critical pass. Measured 1316ms against 586ms for
    // the same work in twelve tiles.
    for (const workers of [2, 4, 8]) {
      const passes = passesFor("pool", 960, 640, workers);
      const coarse = passes[0];
      if (!coarse) throw new Error("no coarse pass");
      const tiles = tileCount(960, 640, coarse.step, coarse.samplesAcross);
      expect(tiles).toBeGreaterThanOrEqual(workers);
      expect(tiles).toBeLessThanOrEqual(workers * 8);
    }
  });

  it("does not overshoot into tiles so small that per-tile overhead wins", () => {
    // Eight-sample tiles measured 2.5x worse per pixel than 32-sample ones.
    const passes = passesFor("pool", 960, 640, 8);
    expect(passes[0]?.samplesAcross).toBeGreaterThanOrEqual(16);
  });

  it("keeps the full pass tiled at least as coarsely as the coarse pass", () => {
    const passes = passesFor("pool", 960, 640, 4);
    const [coarse, full] = passes;
    // The full pass has 64x the samples of the coarse one, so its span must be
    // larger or the pool would be handed thousands of tiles.
    expect(full?.step).toBe(1);
    expect(full?.samplesAcross).toBeGreaterThanOrEqual(coarse?.samplesAcross ?? 0);
    expect(tileCount(960, 640, 1, full?.samplesAcross ?? 0)).toBeLessThanOrEqual(4 * 8);
  });

  it("still produces a tile for a canvas smaller than the smallest span", () => {
    const passes = passesFor("pool", 3, 2, 8);
    expect(passes[0]?.samplesAcross).toBe(8);
    expect(tileCount(3, 2, 8, 8)).toBe(1);
  });

  it("refuses a canvas or worker count that is not a positive integer", () => {
    expect(() => passesFor("pool", 0, 640, 4)).toThrow(/canvas/);
    expect(() => passesFor("pool", 960, 1.5, 4)).toThrow(/canvas/);
    expect(() => passesFor("pool", 960, 640, 0)).toThrow(/workers/);
  });
});
