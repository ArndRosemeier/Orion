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
import { resizeView, scaleExponentOf, type View } from "./domain/view/view";
import { decodeView, encodeView } from "./domain/view/url";
import { AppShell } from "./ui/AppShell";
import { backingPixels } from "./ui/backingScale";
import { useElementSize } from "./ui/useElementSize";

/**
 * The app shell.
 *
 * Rendering goes through the backend seam and the scheduler, and this file knows
 * nothing about shaders, tiles or precision. It holds a view, hands it to the
 * scheduler, and paints what comes back. The presentation frame lives in
 * `AppShell`; the domain seams (`backingPixels`, `resizeView`) decide the pixel
 * grid and re-express the view at it.
 *
 * The scheduler is what makes the interaction honest: a coarse pass lands almost
 * immediately, the full pass follows, and panning mid-render *cancels* the work
 * in flight rather than queueing a stale frame behind it. Failures are shown,
 * never swallowed.
 */

const MAX_ITERATIONS = 600;
const INITIAL_PIXEL_WIDTH = 960;
const INITIAL_PIXEL_HEIGHT = 640;
const RESIZE_DEBOUNCE_MS = 120;

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
    INITIAL_PIXEL_WIDTH,
    INITIAL_PIXEL_HEIGHT,
  );
}

export function App() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const size = useElementSize(viewportRef);
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
  const firstMeasurementRef = useRef(false);
  const resizeTimeoutRef = useRef<number | null>(null);
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
        pixelCount: view.pixelWidth * view.pixelHeight,
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
        view.pixelWidth,
        view.pixelHeight,
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
    if (size.width <= 0 || size.height <= 0) return;
    const display = displayRef.current;
    if (display === null) return;

    // The backing store is set here and nowhere else: `backingPixels` owns the
    // device-pixel and budget decision. The display canvas is never drawn at the
    // placeholder size, which is replaced on this first measurement.
    const backing = backingPixels(
      size.width,
      size.height,
      window.devicePixelRatio || 1,
    );
    // Assigning `canvas.width`/`height` clears the bitmap even when the value is
    // unchanged, so only touch it on a real size change — otherwise a spurious
    // ResizeObserver run would blank a frame that was just painted.
    if (display.width !== backing.width) display.width = backing.width;
    if (display.height !== backing.height) display.height = backing.height;

    const isFirstMeasurement = !firstMeasurementRef.current;
    firstMeasurementRef.current = true;

    if (isFirstMeasurement) {
      // Inside an async call so the error/status updates land on a later tick,
      // which keeps the effect from cascading a render from its own body.
      void (async () => {
        // A shared link wins over the default view, once, on the first real
        // measurement. A link that does not parse is shown as an error rather
        // than silently replaced by the default — opening the wrong place
        // without saying so is the worst possible outcome here. It is not drawn
        // either, so the malformed-link failure stays visible.
        const hash = window.location.hash;
        if (hash.length > 1) {
          try {
            viewRef.current = decodeView(hash).view;
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setStatus("bad link");
            return;
          }
        }
        viewRef.current = resizeView(viewRef.current, backing.width, backing.height);
        // The very first draw is immediate: a debounce would leave the viewport
        // blank for no reason when there is nothing in flight to protect.
        await draw();
      })();
    } else {
      viewRef.current = resizeView(viewRef.current, backing.width, backing.height);
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = window.setTimeout(() => {
        resizeTimeoutRef.current = null;
        void draw();
      }, RESIZE_DEBOUNCE_MS);
    }

    return () => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
    };
  }, [size, draw]);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const view = viewRef.current;
      const px = ((event.clientX - rect.left) / rect.width) * view.pixelWidth;
      const py = ((event.clientY - rect.top) / rect.height) * view.pixelHeight;

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
      const view = viewRef.current;
      const dx = ((event.clientX - drag.x) / rect.width) * view.pixelWidth;
      const dy = ((event.clientY - drag.y) / rect.height) * view.pixelHeight;
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
    <AppShell
      title="Orion"
      tagline="Drag to pan, scroll to zoom. A coarse pass lands first, then the full image; changing the view cancels work in flight."
      centreLabel={centreLabel}
      status={status}
      error={error}
      viewportRef={viewportRef}
    >
      <canvas
        ref={displayRef}
        className="orion-display"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <canvas ref={scratchRef} className="orion-scratch" />
    </AppShell>
  );
}
