/**
 * Visual-line detection for the chat composer's textarea.
 *
 * A `\n` check is not enough: the composer soft-wraps (`.pillMultiline`), so a
 * single logical line renders as several rows. ArrowUp/ArrowDown must only hop
 * into message history from the real first/last rendered row — otherwise a
 * wrapped draft gets replaced by the previous message the moment the caret is
 * on a lower row, and there is no way to walk the caret back up.
 *
 * Rows are located with a marker, not with `scrollHeight`: a box that ends with
 * `\n` reports only its filled rows, so "one\n" reads as a single row and the
 * caret at the start of line 2 would pass for the first row.
 */

let mirror: HTMLDivElement | null = null;

function mirrorElement(): HTMLDivElement {
  if (mirror && mirror.isConnected) return mirror;
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  const s = el.style;
  s.position = "absolute";
  s.top = "0";
  s.left = "-9999px";
  s.visibility = "hidden";
  s.pointerEvents = "none";
  s.boxSizing = "content-box";
  s.margin = "0";
  s.border = "0";
  s.padding = "0";
  document.body.appendChild(el);
  return (mirror = el);
}

/** Styles that decide how the textarea's text wraps and how tall a row is. */
const COPIED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "tabSize",
  "direction",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
  "hyphens",
] as const;

const kebab = (prop: string) => prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function lineHeightPx(cs: CSSStyleDeclaration): number {
  const lh = cs.lineHeight;
  if (lh.endsWith("px")) {
    const px = parseFloat(lh);
    if (Number.isFinite(px) && px > 0) return px;
  }
  const ratio = parseFloat(lh);
  const size = parseFloat(cs.fontSize);
  return Number.isFinite(ratio) ? size * ratio : size * 1.2;
}

/**
 * 0-based index of the rendered row `before` ends on, soft-wraps included. A
 * mirror div carries the textarea's own wrap-affecting styles and width, so the
 * browser does the line breaking we are asking about, and one row-tall marker
 * span pins the row: its top edge is the row's top edge, and an empty trailing
 * line still gets one.
 */
function caretRow(el: HTMLTextAreaElement, before: string): number {
  const cs = getComputedStyle(el);
  const lineHeight = lineHeightPx(cs);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return 0;

  const m = mirrorElement();
  const s = m.style;
  for (const prop of COPIED_STYLES) {
    const value = cs.getPropertyValue(kebab(prop));
    if (value) s.setProperty(kebab(prop), value);
  }
  s.lineHeight = `${lineHeight}px`;
  const contentWidth =
    el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  s.width = `${Math.max(0, contentWidth)}px`;
  m.textContent = before;

  const marker = document.createElement("span");
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = `${lineHeight}px`;
  marker.style.overflow = "hidden";
  marker.style.verticalAlign = "top";
  m.appendChild(marker);

  // The mirror has no padding, so its border box top is the first row's top.
  const top = marker.getBoundingClientRect().top - m.getBoundingClientRect().top;
  marker.remove();
  return Math.max(0, Math.round(top / lineHeight));
}

/** Caret sits on the textarea's first rendered row (so ArrowUp may recall history). */
export function composerCaretOnFirstLine(el: HTMLTextAreaElement): boolean {
  return caretRow(el, el.value.slice(0, el.selectionStart)) === 0;
}

/** Caret sits on the textarea's last rendered row (so ArrowDown may recall history). */
export function composerCaretOnLastLine(el: HTMLTextAreaElement): boolean {
  const lastRow = caretRow(el, el.value);
  return caretRow(el, el.value.slice(0, el.selectionEnd)) >= lastRow;
}
