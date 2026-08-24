import { useLayoutEffect, useRef } from "react";

/**
 * Single-line text that keeps the head and tail of a long string visible and
 * replaces the middle with "…" when it does not fit its container (paths,
 * long titles). The full text is exposed via `title`/`aria-label`.
 */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const width = el.clientWidth;
      el.textContent = text;
      if (el.scrollWidth <= width) return; // full text already set
      const measure = (candidate: string) => {
        el.textContent = candidate;
        return el.scrollWidth;
      };
      // Largest number of characters (head + tail) that still fits.
      let lo = 1;
      let hi = text.length - 1;
      let best = 1;
      while (lo <= hi) {
        const keep = (lo + hi) >> 1;
        const headLen = Math.ceil(keep / 2);
        const head = text.slice(0, headLen);
        const tail = text.slice(text.length - (keep - headLen));
        if (measure(`${head}…${tail}`) <= width) {
          best = keep;
          lo = keep + 1;
        } else {
          hi = keep - 1;
        }
      }
      const headLen = Math.ceil(best / 2);
      const head = text.slice(0, headLen);
      const tail = text.slice(text.length - (best - headLen));
      el.textContent = `${head}…${tail}`;
    };
    fit();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, [text]);

  return (
    <span ref={ref} className={className} title={text} aria-label={text}>
      {text}
    </span>
  );
}
