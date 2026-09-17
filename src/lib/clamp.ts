/** Clamp n into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  if (min > max) {
    throw new Error(`clamp: min (${min}) > max (${max})`);
  }
  return Math.min(max, Math.max(min, n));
}
