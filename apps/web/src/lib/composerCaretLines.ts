/**
 * Visual-line detection for the chat composer's textarea.
 *
 * A `\n` check is not enough: the composer soft-wraps (`.pillMultiline`), so a
 * single logical line renders as several rows. ArrowUp/ArrowDown must only hop
 * into message history from the real first/last rendered row — otherwise a
 * wrapped draft gets replaced by the previous message the moment the caret is
 * on a lower row, and there is no way to walk the caret back up.
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
 * Number of rendered rows `text` occupies in `el`'s box, soft-wraps included.
 * A mirror div carries the textarea's own wrap-affecting styles and width, so
 * the browser does the line breaking we are asking about.
 */
function textRows(el: HTMLTextAreaElement, text: string): number {
  if (!text) return 1;
  const cs = getComputedStyle(el);
  const lineHeight = lineHeightPx(cs);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return 1;

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
  m.textContent = text;

  return Math.max(1, Math.round(m.scrollHeight / lineHeight));
}

/** Caret sits on the textarea's first rendered row (so ArrowUp may recall history). */
export function composerCaretOnFirstLine(el: HTMLTextAreaElement): boolean {
  return textRows(el, el.value.slice(0, el.selectionStart)) <= 1;
}

/** Caret sits on the textarea's last rendered row (so ArrowDown may recall history). */
export function composerCaretOnLastLine(el: HTMLTextAreaElement): boolean {
  return textRows(el, el.value.slice(el.selectionEnd)) <= 1;
}
