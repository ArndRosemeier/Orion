/**
 * Shareable view URLs, at full precision.
 *
 * A fractal find is only shareable if the link reproduces it exactly, and a deep
 * view's centre is a number with hundreds of significant bits. Two encodings are
 * therefore supported, selected explicitly by a `fmt` field so there is never a
 * guess about which one a string is:
 *
 *  - **`e` (exact)** — each coordinate's fixed-point integer written in base 36.
 *    A 256-bit coordinate is ~52 characters, the round trip is bit-exact, and it
 *    is the encoding this module emits.
 *  - **`d` (decimal)** — plain decimal, for a link a human typed or edited. It is
 *    parsed by `fromDecimal`, so a hand-written coordinate keeps every digit it
 *    was given.
 *
 * Every field is validated with a schema before it is used. A malformed or
 * inconsistent link fails loudly with the reason, and `makeView` still runs
 * afterwards — so a link whose precision cannot resolve its own pixel grid is
 * rejected rather than rendered as a field of identical samples.
 */

import { z } from "zod";
import { bigComplex } from "../numeric/bigcomplex";
import { type BigFixed, fromDecimal } from "../numeric/bigfixed";
import { makeView, type View } from "./view";

export const VIEW_URL_VERSION = "1";

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

function toBase36(value: bigint): string {
  return value.toString(36);
}

function fromBase36(text: string): bigint {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  if (body.length === 0) {
    throw new Error(`view url: empty base36 coordinate`);
  }
  let value = 0n;
  for (const character of body) {
    const digit = DIGITS.indexOf(character);
    if (digit < 0) {
      throw new Error(`view url: "${character}" is not a base36 digit`);
    }
    value = value * 36n + BigInt(digit);
  }
  return negative ? -value : value;
}

/**
 * The schema for the *raw* string fields. Kept separate from parsing so a
 * shape error and a numeric error read differently.
 */
const ParamsSchema = z.object({
  v: z.literal(VIEW_URL_VERSION),
  fmt: z.enum(["e", "d"]),
  f: z
    .string()
    .regex(/^\d+$/, "f must be a positive integer")
    .transform((text) => Number(text))
    .pipe(
      z
        .number()
        .int()
        .min(1)
        .max(1 << 20),
    ),
  re: z.string().min(1),
  im: z.string().min(1),
  w: z.string().min(1),
  px: z
    .string()
    .regex(/^\d+$/, "px must be a positive integer")
    .transform((text) => Number(text))
    .pipe(
      z
        .number()
        .int()
        .min(1)
        .max(1 << 16),
    ),
  py: z
    .string()
    .regex(/^\d+$/, "py must be a positive integer")
    .transform((text) => Number(text))
    .pipe(
      z
        .number()
        .int()
        .min(1)
        .max(1 << 16),
    ),
  it: z
    .string()
    .regex(/^\d+$/, "it must be a positive integer")
    .transform((text) => Number(text))
    .pipe(
      z
        .number()
        .int()
        .min(1)
        .max(1 << 24),
    )
    .optional(),
});

export type DecodedView = {
  readonly view: View;
  /** Iteration budget carried by the link, when it carried one. */
  readonly maxIterations: number | null;
};

/** Encode a view as a URL fragment (no leading `#`), exact by construction. */
export function encodeView(view: View, maxIterations?: number): string {
  const fracBits = view.center.re.fracBits;
  const params = new URLSearchParams();
  params.set("v", VIEW_URL_VERSION);
  params.set("fmt", "e");
  params.set("f", String(fracBits));
  params.set("re", toBase36(view.center.re.v));
  params.set("im", toBase36(view.center.im.v));
  params.set("w", toBase36(view.width.v));
  params.set("px", String(view.pixelWidth));
  params.set("py", String(view.pixelHeight));
  if (maxIterations !== undefined) params.set("it", String(maxIterations));
  return params.toString();
}

function parseCoordinate(text: string, format: "e" | "d", fracBits: number): BigFixed {
  if (format === "e") {
    return { v: fromBase36(text), fracBits };
  }
  return fromDecimal(text, fracBits);
}

/**
 * Decode a fragment, with or without a leading `#`.
 *
 * Throws with a readable reason on anything malformed; the caller is expected to
 * surface it rather than fall back to a default view, which would silently show
 * the wrong place.
 */
export function decodeView(text: string): DecodedView {
  const fragment = text.startsWith("#") ? text.slice(1) : text;
  if (fragment.length === 0) {
    throw new Error("view url: empty fragment");
  }
  const raw: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(fragment)) {
    raw[key] = value;
  }
  const parsed = ParamsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `view url: invalid parameters (${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")})`,
    );
  }
  const { fmt, f: fracBits, re, im, w, px, py, it } = parsed.data;

  // `makeView` runs its own checks, so an inconsistent link — a width too coarse
  // for its pixel grid, say — is rejected here rather than rendered as mush.
  const view = makeView(
    bigComplex(parseCoordinate(re, fmt, fracBits), parseCoordinate(im, fmt, fracBits)),
    parseCoordinate(w, fmt, fracBits),
    px,
    py,
  );
  return { view, maxIterations: it ?? null };
}

/** The full shareable link for a view, given the page it lives on. */
export function viewUrl(view: View, base: string, maxIterations?: number): string {
  return `${base}#${encodeView(view, maxIterations)}`;
}
