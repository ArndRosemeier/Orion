/**
 * Colour: continuous escape count in, RGB out.
 *
 * The continuous count `mu = n + 1 - log2(log2|z|)` is not an integer, which is
 * the whole point — banding disappears. Mapping it to a colour is a pure
 * function of `mu` and a palette, so it is identical on every backend: the GPU
 * samples the same palette table the CPU indexes, and a differential test can
 * compare colours rather than only counts.
 */

export type Rgb = {
  readonly r: number;
  readonly g: number;
  readonly b: number;
};

/** Colour used for points that never escaped (inside the set). */
export const INTERIOR_COLOUR: Rgb = { r: 0, g: 0, b: 0 };

export type Palette = {
  readonly name: string;
  /** The stops the table was built from, so it can be rebuilt elsewhere. */
  readonly stops: readonly Rgb[];
  /** Number of entries in the lookup table. */
  readonly size: number;
  /** `at(i)` for `i` in `[0, size)`. */
  at(index: number): Rgb;
  /** Cycles of the palette per unit of escape count. */
  readonly cyclesPerUnit: number;
};

function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

/**
 * Build a palette by linearly interpolating between stops, sampled into a
 * lookup table so a shader can sample it as a texture with the same result.
 */
export function makePalette(
  name: string,
  stops: readonly Rgb[],
  options: { size?: number; cyclesPerUnit?: number } = {},
): Palette {
  if (stops.length < 2) {
    throw new Error(
      `makePalette: at least two stops are required (got ${stops.length})`,
    );
  }
  const size = options.size ?? 256;
  const cyclesPerUnit = options.cyclesPerUnit ?? 0.02;
  if (!Number.isInteger(size) || size < 2) {
    throw new Error(`makePalette: size must be an integer >= 2 (got ${size})`);
  }
  if (!(cyclesPerUnit > 0)) {
    throw new Error(
      `makePalette: cyclesPerUnit must be positive (got ${cyclesPerUnit})`,
    );
  }

  const table: Rgb[] = [];
  for (let i = 0; i < size; i++) {
    const t = (i / size) * (stops.length - 1);
    const low = Math.floor(t);
    const high = Math.min(low + 1, stops.length - 1);
    const blend = t - low;
    const a = stops[low] as Rgb;
    const b = stops[high] as Rgb;
    table.push({
      r: clampByte(a.r + (b.r - a.r) * blend),
      g: clampByte(a.g + (b.g - a.g) * blend),
      b: clampByte(a.b + (b.b - a.b) * blend),
    });
  }

  return {
    name,
    stops,
    size,
    cyclesPerUnit,
    at(index: number): Rgb {
      if (!Number.isInteger(index) || index < 0 || index >= size) {
        throw new Error(`Palette "${name}": index ${index} out of range [0, ${size})`);
      }
      return table[index] as Rgb;
    },
  };
}

/**
 * The lookup index for a continuous escape count.
 *
 * Wrapping is deliberate: escape counts span an unbounded range and the palette
 * is a cycle, so the image remains legible at every depth without rescaling.
 */
export function paletteIndex(smooth: number, palette: Palette): number {
  if (!Number.isFinite(smooth)) {
    throw new Error(`paletteIndex: smooth count must be finite (got ${smooth})`);
  }
  const phase = smooth * palette.cyclesPerUnit;
  const wrapped = phase - Math.floor(phase);
  return Math.min(palette.size - 1, Math.floor(wrapped * palette.size));
}

/** Colour for an escape outcome: interior points take `INTERIOR_COLOUR`. */
export function colourFor(
  outcome: { readonly escaped: boolean; readonly smooth: number | null },
  palette: Palette,
): Rgb {
  if (!outcome.escaped) return INTERIOR_COLOUR;
  if (outcome.smooth === null) {
    throw new Error("colourFor: escaped outcome is missing its smooth count");
  }
  return palette.at(paletteIndex(outcome.smooth, palette));
}

/** A palette with enough range to show structure at any depth. */
export const CLASSIC_PALETTE = makePalette("classic", [
  { r: 0, g: 7, b: 100 },
  { r: 32, g: 107, b: 203 },
  { r: 237, g: 255, b: 255 },
  { r: 255, g: 170, b: 0 },
  { r: 0, g: 2, b: 0 },
]);
