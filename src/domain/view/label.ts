/**
 * How a view is described to a person.
 *
 * The numbers on screen are the only place a user can see that the explorer is
 * still going deeper, so this is not cosmetic: the zoom figure is `2^depth` from
 * the *exact* scale exponent, which keeps counting long after a double would
 * have stopped being able to express the distance between two pixels.
 *
 * Coordinates are truncated for reading and never rounded for use. The digits
 * shown grow with depth, because at 2^-400 the first twenty decimal places of
 * the centre stop changing — showing only those would look like a stuck
 * program. The view, the renderer and the shareable link all keep every bit.
 */

import { type BigFixed, toDecimalString } from "../numeric/bigfixed";
import { scaleExponentOf, type View } from "./view";

/** Fractional digits shown at a shallow view: more than a double carries. */
export const BASE_DISPLAY_DIGITS = 18;

/**
 * A coordinate as decimal text, truncated to `digits` fractional places.
 *
 * The ellipsis is part of the contract: a reader must be able to tell that the
 * display is showing a prefix, so that a truncated label is never mistaken for
 * the whole coordinate.
 */
export function formatCoordinate(value: BigFixed, digits: number): string {
  if (!Number.isInteger(digits) || digits < 0) {
    throw new Error(
      `formatCoordinate: digits must be a non-negative integer (got ${digits})`,
    );
  }
  const text = toDecimalString(value);
  const negative = text.startsWith("-");
  const magnitude = negative ? text.slice(1) : text;
  const sign = negative ? "−" : "";
  const dot = magnitude.indexOf(".");
  if (dot < 0 || magnitude.length - dot - 1 <= digits) return `${sign}${magnitude}`;
  return `${sign}${magnitude.slice(0, dot + 1 + digits)}…`;
}

/** Fractional digits worth showing at this scale (~3.32 bits per digit). */
export function displayDigitsFor(view: View): number {
  const depth = Math.max(0, -scaleExponentOf(view));
  return BASE_DISPLAY_DIGITS + Math.ceil(depth / 3);
}

/**
 * "−0.743643887037151… + 0.13182590420533…i  (zoom 2^412)".
 *
 * The zoom figure is the honest headline: it is derived from the view's own
 * scale, so it is the depth the renderer is being asked for, not an estimate.
 */
export function describeView(view: View): string {
  const digits = displayDigitsFor(view);
  const depth = -scaleExponentOf(view);
  const imaginary = formatCoordinate(view.center.im, digits).replace("−", "");
  return `${formatCoordinate(view.center.re, digits)} ${
    view.center.im.v >= 0n ? "+" : "−"
  } ${imaginary}i  (zoom 2^${depth})`;
}
