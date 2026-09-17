import { describe, expect, it } from "vitest";
import {
  CLASSIC_PALETTE,
  INTERIOR_COLOUR,
  colourFor,
  makePalette,
  paletteIndex,
} from "./palette";

describe("makePalette", () => {
  it("interpolates between stops and hits them exactly", () => {
    const palette = makePalette(
      "two",
      [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 100, b: 50 },
      ],
      { size: 4 },
    );
    // The table samples t = i/size, not i/(size-1): it is a cycle, so the last
    // entry must stop just short of wrapping back to the first.
    expect(palette.at(0)).toEqual({ r: 0, g: 0, b: 0 });
    expect(palette.at(2)).toEqual({ r: 128, g: 50, b: 25 }); // t = 0.5
    expect(palette.at(3)).toEqual({ r: 191, g: 75, b: 38 }); // t = 0.75
    expect(palette.at(3).r).toBeLessThan(255);
  });

  it("clamps bytes into range", () => {
    const palette = makePalette(
      "over",
      [
        { r: -50, g: 300, b: 128 },
        { r: 0, g: 0, b: 0 },
      ],
      { size: 2 },
    );
    expect(palette.at(0)).toEqual({ r: 0, g: 255, b: 128 });
  });

  it("rejects a palette with too few stops or a bad size", () => {
    expect(() => makePalette("bad", [{ r: 0, g: 0, b: 0 }])).toThrow(/two stops/);
    expect(() =>
      makePalette(
        "bad",
        [
          { r: 0, g: 0, b: 0 },
          { r: 1, g: 1, b: 1 },
        ],
        { size: 1 },
      ),
    ).toThrow(/size/);
    expect(() =>
      makePalette(
        "bad",
        [
          { r: 0, g: 0, b: 0 },
          { r: 1, g: 1, b: 1 },
        ],
        {
          cyclesPerUnit: 0,
        },
      ),
    ).toThrow(/cyclesPerUnit/);
  });

  it("reports an out-of-range lookup loudly", () => {
    expect(() => CLASSIC_PALETTE.at(CLASSIC_PALETTE.size)).toThrow(/out of range/);
    expect(() => CLASSIC_PALETTE.at(-1)).toThrow(/out of range/);
  });
});

describe("paletteIndex wraps continuously", () => {
  it("stays inside the table for any escape count", () => {
    const palette = makePalette(
      "p",
      [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 255, b: 255 },
      ],
      { size: 16, cyclesPerUnit: 0.1 },
    );
    for (const smooth of [0, 0.5, 9.99, 10, 123.456, 1e6, -3.2]) {
      const index = paletteIndex(smooth, palette);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(palette.size);
      expect(Number.isInteger(index)).toBe(true);
    }
  });

  it("advances by one full cycle per unit of cyclesPerUnit", () => {
    const palette = makePalette(
      "p",
      [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 255, b: 255 },
      ],
      { size: 100, cyclesPerUnit: 0.5 },
    );
    // Two units of escape count is exactly one cycle: the index returns home.
    expect(paletteIndex(3, palette)).toBe(paletteIndex(1, palette));
    // And half a cycle is halfway round the table.
    expect(paletteIndex(2, palette)).toBe(0);
    expect(paletteIndex(1, palette)).toBe(50);
  });

  it("rejects a non-finite count", () => {
    expect(() => paletteIndex(Number.NaN, CLASSIC_PALETTE)).toThrow(/finite/);
  });
});

describe("colourFor", () => {
  it("returns the interior colour for a bounded point", () => {
    expect(colourFor({ escaped: false, smooth: null }, CLASSIC_PALETTE)).toEqual(
      INTERIOR_COLOUR,
    );
  });

  it("uses the palette for an escaped point", () => {
    const colour = colourFor({ escaped: true, smooth: 12.5 }, CLASSIC_PALETTE);
    expect(colour).toEqual(CLASSIC_PALETTE.at(paletteIndex(12.5, CLASSIC_PALETTE)));
  });

  it("refuses an escaped outcome with no smooth count", () => {
    expect(() => colourFor({ escaped: true, smooth: null }, CLASSIC_PALETTE)).toThrow(
      /smooth count/,
    );
  });
});
