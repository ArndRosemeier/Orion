import { useEffect, useState } from "react";
import type { RefObject } from "react";

export type ElementSize = { readonly width: number; readonly height: number };

/**
 * Track the CSS-pixel size of the element a ref points at.
 *
 * Reports `{ width: 0, height: 0 }` until the first observation, so a caller
 * can distinguish "not measured yet" from a genuinely tiny element. The
 * observer is disconnected on cleanup, which keeps StrictMode's double-invoke
 * from leaving a second observation alive.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const width = Math.max(1, Math.round(entry.contentRect.width));
      const height = Math.max(1, Math.round(entry.contentRect.height));
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
