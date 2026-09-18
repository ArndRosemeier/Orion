import { clamp } from "../lib/clamp";

const DEFAULT_MAX_PIXELS = 2_000_000;
const MAX_SCALE = 2;

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `backingScale: ${name} must be a finite positive number (got ${value})`,
    );
  }
}

/**
 * Pick the device-pixel scale for a CSS-pixel surface.
 *
 * The display is never rendered at more than `devicePixelRatio` (capped at 2 to
 * bound cost), but a large surface is scaled back down until it fits the pixel
 * budget. The result is never below 1: rendering below CSS resolution would be
 * a blurry downscale the caller did not ask for.
 */
export function backingScale(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels: number = DEFAULT_MAX_PIXELS,
): number {
  assertPositiveFinite("cssWidth", cssWidth);
  assertPositiveFinite("cssHeight", cssHeight);
  assertPositiveFinite("devicePixelRatio", devicePixelRatio);
  assertPositiveFinite("maxPixels", maxPixels);

  const preferred = Math.min(Math.max(devicePixelRatio, 1), MAX_SCALE);
  const area = cssWidth * cssHeight;
  if (area * preferred * preferred <= maxPixels) {
    return preferred;
  }
  return clamp(Math.sqrt(maxPixels / area), 1, preferred);
}

/** The integer backing-store size implied by {@link backingScale}. */
export function backingPixels(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels?: number,
): { width: number; height: number } {
  const scale = backingScale(cssWidth, cssHeight, devicePixelRatio, maxPixels);
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}
