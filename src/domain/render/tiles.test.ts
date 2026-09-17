import { describe, expect, it } from "vitest";
import { createLruCache, splitIntoTiles } from "./tiles";
import { tileOutputSize } from "./backend";

function sampleCoverage(
  viewWidth: number,
  viewHeight: number,
  step: number,
  samplesAcross: number,
): Set<string> {
  const grid = splitIntoTiles(viewWidth, viewHeight, step, samplesAcross);
  const covered = new Set<string>();
  for (const tile of grid.tiles) {
    const output = tileOutputSize(tile, step);
    for (let row = 0; row < output.height; row++) {
      for (let column = 0; column < output.width; column++) {
        covered.add(`${tile.x / step + column},${tile.y / step + row}`);
      }
    }
  }
  return covered;
}

describe("splitIntoTiles covers the view exactly", () => {
  const cases: Array<[number, number, number, number]> = [
    [64, 48, 1, 64],
    [64, 48, 8, 64],
    [100, 70, 1, 32],
    [100, 70, 8, 32],
    [7, 5, 1, 4],
    [7, 5, 3, 2],
    [1, 1, 1, 64],
    [1000, 640, 8, 64],
  ];

  for (const [width, height, step, samplesAcross] of cases) {
    it(`covers ${width}x${height} at step ${step} with ${samplesAcross}-sample tiles`, () => {
      const grid = splitIntoTiles(width, height, step, samplesAcross);
      const expected = new Set<string>();
      for (let row = 0; row < grid.rows; row++) {
        for (let column = 0; column < grid.columns; column++) {
          expected.add(`${column},${row}`);
        }
      }
      const covered = sampleCoverage(width, height, step, samplesAcross);
      // Exact coverage: nothing missing and nothing sampled twice.
      expect(covered.size).toBe(expected.size);
      for (const key of expected) expect(covered.has(key)).toBe(true);
    });
  }

  it("keeps every tile inside the view", () => {
    const grid = splitIntoTiles(100, 70, 8, 32);
    for (const tile of grid.tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.width).toBeLessThanOrEqual(100);
      expect(tile.y + tile.height).toBeLessThanOrEqual(70);
    }
  });

  it("rounds the sample grid up for a view that is not a multiple of the step", () => {
    const grid = splitIntoTiles(100, 70, 8, 64);
    expect(grid.columns).toBe(13); // ceil(100/8)
    expect(grid.rows).toBe(9); // ceil(70/8)
  });

  it("rejects bad geometry loudly", () => {
    expect(() => splitIntoTiles(0, 10, 1, 8)).toThrow(/positive integer/);
    expect(() => splitIntoTiles(10, 10, 0, 8)).toThrow(/positive integer/);
    expect(() => splitIntoTiles(10, 10, 1, 0)).toThrow(/positive integer/);
  });
});

describe("tileOutputSize", () => {
  it("rounds a partial trailing sample up", () => {
    expect(tileOutputSize({ x: 0, y: 0, width: 100, height: 70 }, 8)).toEqual({
      width: 13,
      height: 9,
    });
  });

  it("rejects a non-positive step", () => {
    expect(() => tileOutputSize({ x: 0, y: 0, width: 8, height: 8 }, 0)).toThrow(
      /positive integer/,
    );
  });
});

describe("createLruCache", () => {
  it("returns what it stored, and counts hits and misses", () => {
    const cache = createLruCache<string, number>(2);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
    expect(cache.has("a")).toBe(true);
  });

  it("evicts the least recently used entry, not the oldest written", () => {
    const cache = createLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    // Touching "a" makes "b" the least recently used.
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.evictions).toBe(1);
  });

  it("never exceeds its capacity", () => {
    const cache = createLruCache<number, number>(3);
    for (let i = 0; i < 50; i++) cache.set(i, i);
    expect(cache.size).toBe(3);
    expect(cache.evictions).toBe(47);
  });

  it("re-setting an existing key refreshes it without growing", () => {
    const cache = createLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(2);
  });

  it("clears on demand", () => {
    const cache = createLruCache<string, number>(2);
    cache.set("a", 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has("a")).toBe(false);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => createLruCache<string, number>(0)).toThrow(/positive integer/);
  });
});
