import { describe, expect, it } from "vitest";
import { CLASSIC_PALETTE } from "../color/palette";
import { bigComplex } from "../numeric/bigcomplex";
import { fromFloat, toFloat } from "../numeric/bigfixed";
import { makeView, pixelToComplex, type View } from "../view/view";
import { createTileCache } from "./tiles";
import {
  type Capability,
  type FractalBackend,
  type TileRequest,
  type TileResult,
} from "./backend";
import { DEFAULT_PASSES, renderView, type PassImage } from "./scheduler";

const F = 256;

function view(pixelWidth = 100, pixelHeight = 70) {
  return makeView(
    bigComplex(fromFloat(-0.75, F), fromFloat(0.1, F)),
    fromFloat(1, F),
    pixelWidth,
    pixelHeight,
  );
}

type Recorded = {
  readonly requests: TileRequest[];
  pixelsWritten: number;
};

/**
 * A stub backend that records what it was asked for and paints a value unique to
 * each sample. It exists so the scheduler's coverage rules can be checked
 * without a real renderer in the way — the point of this file is the schedule,
 * not the fractal.
 */
function stubBackend(
  recorded: Recorded,
  options: { supported?: boolean; why?: string } = {},
): FractalBackend {
  return {
    name: "stub",
    capability(): Capability {
      return { supported: options.supported ?? true, why: options.why ?? "stub" };
    },
    async render(request: TileRequest, into: TileResult): Promise<TileResult> {
      recorded.requests.push(request);
      for (let i = 0; i < into.pixels.length; i += 4) {
        into.pixels[i] = 1;
        into.pixels[i + 1] = 2;
        into.pixels[i + 2] = 3;
        into.pixels[i + 3] = 255;
        recorded.pixelsWritten++;
      }
      into.stage = "stub";
      return into;
    },
    dispose(): void {},
  };
}

describe("renderView walks every pass and every tile", () => {
  it("produces one image per pass, correctly sized", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    const outcome = await renderView({
      backend: stubBackend(recorded),
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
    });
    expect(outcome.cancelled).toBe(false);
    expect(outcome.passes).toHaveLength(DEFAULT_PASSES.length);
    const coarse = outcome.passes[0] as PassImage;
    const full = outcome.passes[1] as PassImage;
    expect(coarse.step).toBe(8);
    expect(coarse.width).toBe(13);
    expect(coarse.height).toBe(9);
    expect(full.step).toBe(1);
    expect(full.width).toBe(100);
    expect(full.height).toBe(70);
  });

  it("leaves no sample unwritten in either pass", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    const outcome = await renderView({
      backend: stubBackend(recorded),
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
    });
    for (const pass of outcome.passes) {
      let unwritten = 0;
      for (let i = 3; i < pass.pixels.length; i += 4) {
        if (pass.pixels[i] === 0) unwritten++;
      }
      expect(unwritten).toBe(0);
    }
  }, 60_000);

  it("cuts the full-resolution pass into tiles rather than one call", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    await renderView({
      backend: stubBackend(recorded),
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
      passes: [{ name: "full", step: 1, samplesAcross: 32 }],
    });
    // 100x70 at 32 samples across is 4 columns by 3 rows of tiles.
    expect(recorded.requests).toHaveLength(12);
    expect(recorded.requests.every((request) => request.step === 1)).toBe(true);
  });

  it("passes the step through to the backend", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    await renderView({
      backend: stubBackend(recorded),
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
      passes: [
        { name: "coarse", step: 4, samplesAcross: 16 },
        { name: "full", step: 2, samplesAcross: 16 },
      ],
    });
    expect(new Set(recorded.requests.map((request) => request.step))).toEqual(
      new Set([4, 2]),
    );
  });

  it("reports each pass as soon as it is complete", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    const seen: string[] = [];
    await renderView({
      backend: stubBackend(recorded),
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
      onPass: (image) => seen.push(`${image.name}:${image.step}`),
    });
    expect(seen).toEqual(["coarse:8", "full:1"]);
  });
});

describe("renderView cancels instead of lying", () => {
  it("does no work at all when the signal is already aborted", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    const controller = new AbortController();
    controller.abort();
    const outcome = await renderView({
      backend: stubBackend(recorded),
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
      signal: controller.signal,
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.tilesRendered).toBe(0);
    expect(recorded.requests).toHaveLength(0);
  });

  it("stops between tiles and returns what it finished", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    const controller = new AbortController();
    const backend = stubBackend(recorded);
    const wrapped: FractalBackend = {
      ...backend,
      async render(request, into) {
        const result = await backend.render(request, into);
        // Abort once a few tiles are in flight, mid-tile-boundary.
        if (recorded.requests.length >= 3) controller.abort();
        return result;
      },
    };
    const outcome = await renderView({
      backend: wrapped,
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
      signal: controller.signal,
      passes: [{ name: "full", step: 1, samplesAcross: 16 }],
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.tilesRendered).toBeGreaterThan(0);
    // It stopped early: far fewer than the full grid of tiles.
    expect(outcome.tilesRendered).toBeLessThan(28);
    expect(outcome.passes).toHaveLength(0);
  });

  it("reports no completed pass when cancelled during the first one", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    const controller = new AbortController();
    const backend = stubBackend(recorded);
    const wrapped: FractalBackend = {
      ...backend,
      async render(request, into) {
        controller.abort();
        return backend.render(request, into);
      },
    };
    const outcome = await renderView({
      backend: wrapped,
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
      signal: controller.signal,
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.passes).toHaveLength(0);
  });
});

describe("renderView surfaces an incapable backend", () => {
  it("throws with the backend's reason when capability is required", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    await expect(
      renderView({
        backend: stubBackend(recorded, { supported: false, why: "no float target" }),
        view: view(),
        maxIterations: 100,
        palette: CLASSIC_PALETTE,
        quality: "exact",
        requireCapability: true,
      }),
    ).rejects.toThrow(/no float target/);
    expect(recorded.requests).toHaveLength(0);
  });

  it("renders anyway when capability is not required", async () => {
    const recorded: Recorded = { requests: [], pixelsWritten: 0 };
    const outcome = await renderView({
      backend: stubBackend(recorded, { supported: false, why: "claimed incapable" }),
      view: view(),
      maxIterations: 100,
      palette: CLASSIC_PALETTE,
      quality: "preview",
    });
    expect(outcome.cancelled).toBe(false);
    expect(recorded.requests.length).toBeGreaterThan(0);
  });
});

/**
 * A stub that paints each sample from its *complex coordinate*.
 *
 * A constant-colour stub cannot tell a correctly placed cached tile from a
 * misplaced one, so it cannot validate a tile cache. This one can.
 */
function paintAt(view: View, px: number, py: number): [number, number, number, number] {
  const c = pixelToComplex(view, px, py);
  const re = Math.abs(toFloat(c.re));
  const im = Math.abs(toFloat(c.im));
  return [
    Math.floor((re * 1e6) % 256),
    Math.floor((im * 1e6) % 256),
    Math.floor(((re + im) * 1e5) % 256),
    255,
  ];
}

function coordinateStubBackend(): FractalBackend {
  return {
    name: "coordinate-stub",
    capability: () => ({ supported: true, why: "stub" }),
    async render(request: TileRequest, into: TileResult): Promise<TileResult> {
      for (let row = 0; row < into.height; row++) {
        for (let column = 0; column < into.width; column++) {
          const pixel = paintAt(
            request.view,
            request.tile.x + column * request.step,
            request.tile.y + row * request.step,
          );
          const offset = (row * into.width + column) * 4;
          into.pixels[offset] = pixel[0];
          into.pixels[offset + 1] = pixel[1];
          into.pixels[offset + 2] = pixel[2];
          into.pixels[offset + 3] = pixel[3];
        }
      }
      into.stage = "coordinate-stub";
      return into;
    },
    dispose(): void {},
  };
}

/**
 * What the image *must* be, computed directly from the view — no tiles, no
 * cache, no scheduler. This is the oracle, and it is the only thing that can
 * catch a cache that is self-consistently wrong.
 */
function oraclePixels(view: View): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(view.pixelWidth * view.pixelHeight * 4);
  for (let y = 0; y < view.pixelHeight; y++) {
    for (let x = 0; x < view.pixelWidth; x++) {
      const pixel = paintAt(view, x, y);
      const offset = (y * view.pixelWidth + x) * 4;
      pixels[offset] = pixel[0];
      pixels[offset + 1] = pixel[1];
      pixels[offset + 2] = pixel[2];
      pixels[offset + 3] = pixel[3];
    }
  }
  return pixels;
}

/**
 * A view already sitting exactly on the sample lattice, so snapping is the
 * identity and the rendered image can be compared to the oracle pixel for
 * pixel.
 *
 * Pixel size is 2^-8 and the centre is an odd multiple of 2^-9, which puts
 * every pixel centre on an exact multiple of 2^-8 — every product below is
 * exact in binary fixed point, so "aligned" is exact rather than nearly.
 */
function alignedView(pixelWidth = 64, pixelHeight = 48, panX = 0, panY = 0): View {
  const re = (2 * -11 + pixelWidth - 1 + 2 * panX) * 2 ** -9;
  const im = (2 * 7 + pixelHeight - 1 + 2 * panY) * 2 ** -9;
  return makeView(
    bigComplex(fromFloat(re, F), fromFloat(im, F)),
    fromFloat(0.25, F),
    pixelWidth,
    pixelHeight,
  );
}

const LATTICE_PASSES = [{ name: "full", step: 1, samplesAcross: 32 }];

async function renderLatticed(
  backend: FractalBackend,
  target: View,
  cache: ReturnType<typeof createTileCache>,
) {
  return renderView({
    backend,
    view: target,
    maxIterations: 10,
    palette: CLASSIC_PALETTE,
    quality: "preview",
    passes: LATTICE_PASSES,
    tileCache: cache,
  });
}

describe("the tile cache reuses tiles without changing the image", () => {
  it("paints the oracle exactly, cold and warm, while reusing tiles across a pan", async () => {
    const original = alignedView();
    // The pan moves the row index as well as the column index. A cache key
    // that forgets either one passes a warm-vs-cold comparison (both sides
    // are then wrong the same way) but cannot pass the oracle.
    const panned = alignedView(64, 48, 16, 12);
    const expected = oraclePixels(panned);

    const cold = await renderLatticed(
      coordinateStubBackend(),
      panned,
      createTileCache(256),
    );
    const coldImage = cold.passes[0];
    expect(coldImage).toBeDefined();
    if (!coldImage) return;
    // Also proves the snapped view is bit-identical to the one asked for.
    expect(coldImage.pixels).toEqual(expected);

    const cache = createTileCache(256);
    await renderLatticed(coordinateStubBackend(), original, cache);
    const before = cache.stats();
    const warm = await renderLatticed(coordinateStubBackend(), panned, cache);
    const warmImage = warm.passes[0];
    expect(warmImage).toBeDefined();
    if (!warmImage) return;

    expect(warmImage.pixels).toEqual(expected);
    expect(cache.stats().hits).toBeGreaterThan(before.hits);
    expect(warm.tilesSkipped).toBeGreaterThan(0);
    expect(warm.tilesRendered).toBeLessThan(cold.tilesRendered);
  }, 60_000);

  it("still cancels, and still refuses to report a pass it did not finish", async () => {
    const controller = new AbortController();
    let calls = 0;
    const backend = coordinateStubBackend();
    const wrapped: FractalBackend = {
      ...backend,
      async render(request, into) {
        const result = await backend.render(request, into);
        calls++;
        if (calls >= 2) controller.abort();
        return result;
      },
    };
    const outcome = await renderView({
      backend: wrapped,
      view: alignedView(),
      maxIterations: 10,
      palette: CLASSIC_PALETTE,
      quality: "preview",
      passes: LATTICE_PASSES,
      signal: controller.signal,
      tileCache: createTileCache(64),
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.passes).toHaveLength(0);
  }, 60_000);
});
