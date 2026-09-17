/**
 * How a double crosses into a shader: as an unevaluated `(hi, lo)` pair of `f32`s.
 *
 * Both GPU backends upload view coordinates this way, because a `f32` uniform
 * cannot hold a pixel offset at depth — the coordinate itself is fine, but the
 * *step* between adjacent pixels is not, and the difference between two nearby
 * coordinates is exactly what the renderer needs.
 *
 * One implementation, because the split is part of the numerical contract: a
 * Veltkamp split that rounded differently in one backend would show up as one
 * backend drifting from the oracle sooner than the other, which is a difference
 * nobody would think to look for.
 */

/**
 * Split `value` into `(hi, lo)` with `hi + lo === value` exactly.
 *
 * `hi` is `value` rounded to 24 significant bits, so the pair carries about 48
 * bits between them — enough to represent a 2^-30 pixel step that a single `f32`
 * collapses to zero.
 */
export function splitDouble(value: number): [number, number] {
  const hi = Math.fround(value);
  return [hi, value - hi];
}
