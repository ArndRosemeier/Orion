/**
 * Tile splitting and the two caches the render loop needs.
 *
 * Tiles are cut in *sample* space, not device space: a pass samples every `step`
 * device pixels, so a tile of `samplesAcross` samples covers
 * `samplesAcross * step` device pixels — clipped at the view edge so the last
 * tile never reaches past it.
 *
 * The caches are deliberately separate. A tile cache keyed by a view can only
 * answer exact repeats; a reference-orbit cache is what actually pays off,
 * because every tile of a view shares one orbit once the reference point is the
 * view centre rather than the tile centre.
 */

import {
  type BigFixed,
  add,
  fromFloat,
  fromInt,
  isZero,
  mul,
  sub,
} from "../numeric/bigfixed";
import { bigComplex } from "../numeric/bigcomplex";
import { makeView, pixelSizeOf, pixelToComplex, type View } from "../view/view";
import type { TileRect } from "./backend";

export type TileGrid = {
  readonly columns: number;
  readonly rows: number;
  readonly tiles: readonly TileRect[];
};

/**
 * Split a view into tiles of at most `samplesAcross` samples, for a pass that
 * samples every `step` device pixels.
 */
export function splitIntoTiles(
  viewWidth: number,
  viewHeight: number,
  step: number,
  samplesAcross: number,
): TileGrid {
  if (
    !Number.isInteger(viewWidth) ||
    viewWidth < 1 ||
    !Number.isInteger(viewHeight) ||
    viewHeight < 1
  ) {
    throw new Error(
      `splitIntoTiles: view must have positive integer dimensions (got ${viewWidth}x${viewHeight})`,
    );
  }
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`splitIntoTiles: step must be a positive integer (got ${step})`);
  }
  if (!Number.isInteger(samplesAcross) || samplesAcross < 1) {
    throw new Error(
      `splitIntoTiles: samplesAcross must be a positive integer (got ${samplesAcross})`,
    );
  }

  const columns = Math.ceil(viewWidth / step);
  const rows = Math.ceil(viewHeight / step);
  const tiles: TileRect[] = [];

  for (let row = 0; row < rows; row += samplesAcross) {
    for (let column = 0; column < columns; column += samplesAcross) {
      const x = column * step;
      const y = row * step;
      const samplesWide = Math.min(samplesAcross, columns - column);
      const samplesHigh = Math.min(samplesAcross, rows - row);
      // The trailing sample may sit past the last device pixel; clip the device
      // rect so every tile stays inside the view. `tileOutputSize` then recovers
      // the sample count exactly.
      const width = Math.min(samplesWide * step, viewWidth - x);
      const height = Math.min(samplesHigh * step, viewHeight - y);
      tiles.push({ x, y, width, height });
    }
  }

  return { columns, rows, tiles };
}

export type LruCache<K, V> = {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  readonly size: number;
  readonly capacity: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  clear(): void;
};

/** A bounded least-recently-used cache over `Map` insertion order. */
export function createLruCache<K, V>(capacity: number): LruCache<K, V> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(
      `createLruCache: capacity must be a positive integer (got ${capacity})`,
    );
  }
  const entries = new Map<K, V>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) {
        misses++;
        return undefined;
      }
      hits++;
      // Refresh recency: delete and re-insert moves it to the end.
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
        evictions++;
      }
    },
    has(key) {
      return entries.has(key);
    },
    get size() {
      return entries.size;
    },
    capacity,
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    get evictions() {
      return evictions;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * A cache of rendered tiles, keyed by their position on an absolute lattice.
 *
 * Viewport-cut tiles cannot be reused when the view moves, because a tile's
 * contents depend on where the viewport happened to fall. Tiles on an absolute
 * lattice can: tile `(k, l)` covers the same complex region for every view at
 * the same sample spacing, so panning reuses every tile it did not uncover.
 *
 * The lattice is the *sample* lattice: sample `j` sits at `j * sampleSize` in
 * complex space, where `sampleSize` is the pixel spacing times the pass step.
 * For that to hold, the view has to be snapped onto the lattice first, which
 * moves the image by at most half a sample — under the resolution of the pass
 * that is being rendered, by construction.
 */

export type CachedTile = {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
};

export type TileCache = {
  readonly cache: LruCache<string, CachedTile>;
  stats(): { size: number; hits: number; misses: number; evictions: number };
};

export function createTileCache(capacity: number): TileCache {
  const cache = createLruCache<string, CachedTile>(capacity);
  return {
    cache,
    stats() {
      return {
        size: cache.size,
        hits: cache.hits,
        misses: cache.misses,
        evictions: cache.evictions,
      };
    },
  };
}

/**
 * A token for the sample spacing, which is what decides whether two views can
 * share tiles. `width / pixelWidth` reduced is the pixel spacing; the step turns
 * that into the sample spacing. Both are exact integers, so equal spacings always
 * produce equal tokens.
 */
export function sampleLatticeKey(view: View, step: number): string {
  const numerator = view.width.v < 0n ? -view.width.v : view.width.v;
  const divisor = greatestCommonDivisor(numerator, BigInt(view.pixelWidth));
  return `${numerator / divisor}/${BigInt(view.pixelWidth) / divisor}|${view.width.fracBits}|${step}`;
}

export function tileCacheKey(
  lattice: string,
  samplesAcross: number,
  k: bigint,
  l: bigint,
): string {
  return `${lattice}|${samplesAcross}|${k}|${l}`;
}

export function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/** Round-half-away-from-zero integer division, matching the one rounding rule. */
export function divideRoundedBigInt(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("divideRoundedBigInt: division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const rounded = (n - quotient * d) * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Floor division, for lattice indices that may be negative. */
export function floorDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("floorDivide: denominator must be positive");
  const quotient = numerator / denominator;
  return numerator < 0n && quotient * denominator !== numerator
    ? quotient - 1n
    : quotient;
}

export type LatticedView = {
  /** The view moved onto the lattice; render this, not the one you were given. */
  readonly view: View;
  /** Lattice index of the snapped view's first sample, per axis. */
  readonly originK: bigint;
  readonly originL: bigint;
  readonly sampleRe: BigFixed;
  readonly sampleIm: BigFixed;
  /** Samples per axis in this pass. */
  readonly columns: number;
  readonly rows: number;
  readonly samplesAcross: number;
  readonly step: number;
  readonly firstK: bigint;
  readonly lastK: bigint;
  readonly firstL: bigint;
  readonly lastL: bigint;
};

/**
 * Snap a view onto the sample lattice and work out which absolute tiles it needs.
 *
 * Snapping is what makes reuse possible at all: it forces the samples onto
 * positions that do not depend on where the view happens to sit.
 */
export function latticeView(
  view: View,
  step: number,
  samplesAcross: number,
): LatticedView {
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`latticeView: step must be a positive integer (got ${step})`);
  }
  if (!Number.isInteger(samplesAcross) || samplesAcross < 1) {
    throw new Error(
      `latticeView: samplesAcross must be a positive integer (got ${samplesAcross})`,
    );
  }
  const fracBits = view.width.fracBits;
  const origin = pixelToComplex(view, 0, 0);
  const sampleRe = sub(pixelToComplex(view, step, 0).re, origin.re);
  const sampleIm = sub(pixelToComplex(view, 0, step).im, origin.im);
  if (isZero(sampleRe) || isZero(sampleIm)) {
    throw new Error("latticeView: the view has a zero sample spacing");
  }

  const originK = divideRoundedBigInt(origin.re.v, sampleRe.v);
  const originL = divideRoundedBigInt(origin.im.v, sampleIm.v);
  const pixelSize = pixelSizeOf(view);
  // Rebuild the centre so that its first sample lands exactly on the lattice.
  const snapped = makeView(
    bigComplex(
      add(
        mul(fromInt(originK, fracBits), sampleRe),
        mul(fromFloat(view.pixelWidth / 2 - 0.5, fracBits), pixelSize),
      ),
      add(
        mul(fromInt(originL, fracBits), sampleIm),
        mul(fromFloat(view.pixelHeight / 2 - 0.5, fracBits), pixelSize),
      ),
    ),
    view.width,
    view.pixelWidth,
    view.pixelHeight,
  );

  const columns = Math.ceil(view.pixelWidth / step);
  const rows = Math.ceil(view.pixelHeight / step);
  const span = BigInt(samplesAcross);
  return {
    view: snapped,
    originK,
    originL,
    sampleRe,
    sampleIm,
    columns,
    rows,
    samplesAcross,
    step,
    firstK: floorDivide(originK, span),
    lastK: floorDivide(originK + BigInt(columns - 1), span),
    firstL: floorDivide(originL, span),
    lastL: floorDivide(originL + BigInt(rows - 1), span),
  };
}
