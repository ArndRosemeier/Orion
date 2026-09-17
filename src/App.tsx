import { useCallback, useEffect, useRef, useState } from "react";
import { CLASSIC_PALETTE } from "./domain/color/palette";
import { measurementFor, viewMeasurementKey } from "./domain/ladder/measurements";
import { planView } from "./domain/ladder/plan";
import { panByPixels, viewFromDoubles, zoomAtPixel } from "./domain/view/navigate";
import { createWebGl2Backend } from "./domain/render/webgl2";
import { createWebGpuBackend } from "./domain/render/webgpu";
import { createWorkerPool } from "./domain/render/workerPool";
import { chooseBackend } from "./domain/render/select";
import { type PassImage, renderView } from "./domain/render/scheduler";
import { createTileCache, type TileCache } from "./domain/render/tiles";
import { type BackendKind, passesFor } from "./domain/render/passes";
import { describeView } from "./domain/view/label";
import { scaleExponentOf, type View } from "./domain/view/view";
import { decodeView, encodeView } from "./domain/view/url";

/**
 * The app shell.
 *
 * Rendering goes through the backend seam and the scheduler, and this file knows
 * nothing about shaders, tiles or precision. It holds a view, hands it to the
 * scheduler, and paints what comes back.
 *
 * The scheduler is what makes the interaction honest: a coarse pass lands almost
 * immediately, the full pass follows, and panning mid-render *cancels* the work
 * in flight rather than queueing a stale frame behind it. Failures are shown,
 * never swallowed.
 */

const MAX_ITERATIONS = 600;
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 640;

/**
 * Rendered tiles, kept across frames. Without this, every pan and every zoom
 * re-renders the whole viewport; with it, a pan re-renders only the strip it
 * uncovered. Bounded, so a long zoom session cannot grow without limit.
 */
const TILE_CACHE_CAPACITY = 512;

const INITIAL = { re: -0.75, im: 0.1, width: 3 };

function initialView(): View {
  return viewFromDoubles(
    INITIAL.re,
    INITIAL.im,
    INITIAL.width,
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  );
}

export function App() {
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const backendsRef = useRef<
    {
      name: string;
      backendKind: BackendKind;
      backend: ReturnType<typeof createWebGl2Backend>;
      concurrency?: number;
    }[]
  >([]);
  const abortRef = useRef<AbortController | null>(null);
  const tileCacheRef = useRef<TileCache | null>(null);
  if (tileCacheRef.current === null) {
    tileCacheRef.current = createTileCache(TILE_CACHE_CAPACITY);
  }
  const viewRef = useRef<View>(initialView());
  const [status, setStatus] = useState("starting");
  const [error, setError] = useState<string | null>(null);
  const [centreLabel, setCentreLabel] = useState("");

  useEffect(() => {
    // GPU-first: the compute backend is tried before the fragment-shader one.
    // The GPU backends render into their own detached canvas; the visible canvas
    // is a plain 2D surface that displays the scheduler's assembled passes.
    const glCanvas = document.createElement("canvas");
    // The worker pool is last because it is the slowest per pixel — but it is
    // the one that keeps the main thread free, so it is the right fallback at
    // depths no GPU float type can reach.
    const pool = createWorkerPool();
    backendsRef.current = [
      { name: "webgpu", backendKind: "gpu", backend: createWebGpuBackend() },
      { name: "webgl2", backendKind: "gpu", backend: createWebGl2Backend(glCanvas) },
      { name: "cpu-pool", backendKind: "pool", backend: pool, concurrency: pool.size },
    ];
    return () => {
      abortRef.current?.abort();
      for (const candidate of backendsRef.current) candidate.backend.dispose();
      backendsRef.current = [];
    };
  }, []);

  const paint = useCallback((image: PassImage) => {
    const display = displayRef.current;
    const scratch = scratchRef.current;
    if (!display || !scratch) return;
    scratch.width = image.width;
    scratch.height = image.height;
    const scratchContext = scratch.getContext("2d");
    const target = display.getContext("2d");
    if (!scratchContext || !target) {
      setError("2D context unavailable for the display surface");
      return;
    }
    // Copied into a fresh ArrayBuffer-backed view: `ImageData` will not take a
    // possibly-shared backing store, and the copy is one per pass, not per tile.
    scratchContext.putImageData(
      new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height),
      0,
      0,
    );
    target.imageSmoothingEnabled = false;
    target.clearRect(0, 0, display.width, display.height);
    target.drawImage(scratch, 0, 0, display.width, display.height);
  }, []);

  const draw = useCallback(async () => {
    if (backendsRef.current.length === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const view = viewRef.current;
    try {
      const scaleExponent = scaleExponentOf(view);
      // The ladder prices the series stage from what a previous render of this
      // view actually validated; with nothing measured it prices the unskipped
      // path, which is the honest assumption rather than a hopeful one.
      const measured = measurementFor(viewMeasurementKey(view, MAX_ITERATIONS));
      const plan = planView({
        scaleExponent,
        maxIterations: MAX_ITERATIONS,
        pixelCount: CANVAS_WIDTH * CANVAS_HEIGHT,
        quality: "preview",
        measuredSeriesSkip: measured?.seriesSkip ?? 0,
      });
      setCentreLabel(describeView(view));
      const choice = chooseBackend(backendsRef.current, view, plan);
      if (choice.kind === "refused") {
        setError(
          `no backend can render this view:\n${choice.reasons.map((entry) => `  ${entry.name}: ${entry.why}`).join("\n")}`,
        );
        setStatus("refused");
        return;
      }
      // The tiling follows the backend that will do the work: a GPU renders the
      // coarse pass in one draw call, while a pool needs enough tiles that every
      // worker has several waves — one tile would mean one worker.
      const passes = passesFor(
        choice.backendKind,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        choice.concurrency ?? 1,
      );
      const outcome = await renderView({
        backend: choice.backend,
        view,
        maxIterations: MAX_ITERATIONS,
        palette: CLASSIC_PALETTE,
        quality: "preview",
        passes,
        signal: controller.signal,
        onPass: paint,
        requireCapability: true,
        concurrency: choice.concurrency,
        tileCache: tileCacheRef.current ?? undefined,
      });
      if (outcome.cancelled) return; // superseded by a newer view
      // Keep the address bar in step with what is on screen, so whatever the
      // user is looking at is what they would share. `replaceState` rather than
      // `pushState`: panning would otherwise fill the history with every frame.
      window.history.replaceState(null, "", `#${encodeView(view, MAX_ITERATIONS)}`);

      setError(null);
      setStatus(
        `${choice.name} · ${plan.stage} → ${outcome.stages.join("/")} · ${outcome.passes.length} passes · ${outcome.tilesRendered} tiles (${outcome.tilesSkipped} reused) · preview`,
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("failed");
    }
  }, [paint]);

  useEffect(() => {
    let cancelled = false;
    // A shared link wins over the default view. A link that does not parse is
    // shown as an error rather than silently replaced by the default — opening
    // the wrong place without saying so is the worst possible outcome here.
    void (async () => {
      const hash = window.location.hash;
      if (hash.length > 1) {
        try {
          const decoded = decodeView(hash);
          // Kept exactly as decoded. A deep link carries hundreds of bits, and
          // rounding it through a double here would silently open a shallower
          // place than the one that was shared.
          viewRef.current = decoded.view;
        } catch (cause) {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setStatus("bad link");
          return;
        }
      }
      if (!cancelled) await draw();
    })();
    return () => {
      cancelled = true;
    };
  }, [draw]);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH;
      const py = ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT;

      // Keep the complex point under the cursor fixed while zooming. Both the
      // point and the new centre are computed in fixed point at the precision
      // the *new* scale needs, so this keeps working at 2^-1000.
      const factor = Math.exp(event.deltaY * 0.0015);
      try {
        viewRef.current = zoomAtPixel(viewRef.current, px, py, factor);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("failed");
        return;
      }
      void draw();
    },
    [draw],
  );

  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const dx = ((event.clientX - drag.x) / rect.width) * CANVAS_WIDTH;
      const dy = ((event.clientY - drag.y) / rect.height) * CANVAS_HEIGHT;
      viewRef.current = panByPixels(viewRef.current, dx, dy);
      dragRef.current = { x: event.clientX, y: event.clientY };
      void draw();
    },
    [draw],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 16 }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Orion</h1>
      <p style={{ margin: "0 0 12px", color: "#555", fontSize: 13 }}>
        Drag to pan, scroll to zoom. A coarse pass lands first, then the full image;
        changing the view cancels work in flight.
      </p>
      <canvas
        ref={displayRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          display: "block",
          cursor: "grab",
          border: "1px solid #ccc",
          maxWidth: "100%",
        }}
      />
      <canvas ref={scratchRef} style={{ display: "none" }} />
      <p
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          margin: "8px 0 0",
        }}
      >
        {centreLabel}
      </p>
      <p
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          margin: "4px 0 0",
          color: "#555",
        }}
      >
        {status}
      </p>
      {error !== null && (
        <p
          role="alert"
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            margin: "8px 0 0",
            color: "#a00",
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </p>
      )}
    </main>
  );
}
