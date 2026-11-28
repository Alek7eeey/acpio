/**
 * An OpenDocument text file (`.odt`) drawn as the document it is. ODF is zipped
 * XML — `content.xml` holds the paragraphs and `styles.xml` the named styles —
 * so the reader here is a small, honest one: headings, paragraphs, lists, tables
 * and the inline properties the document itself carries (bold, italic,
 * underline, size, colour, alignment).
 *
 * What it does not do is a page layout: ODF pagination is a rendering engine's
 * job, and a diff pane is a column anyway.
 */
import type JSZip from "jszip";

type StyleProps = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  size?: string;
  align?: string;
  strike?: boolean;
};

const TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const STYLE_NS = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const FO_NS = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
const TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";

function attr(el: Element, ns: string, name: string): string | null {
  return el.getAttributeNS(ns, name);
}

/** The named and automatic styles of a document, keyed by their ODF name. */
function readStyles(doc: Document): Map<string, StyleProps> {
  const styles = new Map<string, StyleProps>();
  for (const el of doc.getElementsByTagNameNS(STYLE_NS, "style")) {
    const name = el.getAttributeNS(STYLE_NS, "name");
    if (!name) continue;
    const props: StyleProps = {};
    const text = el.getElementsByTagNameNS(STYLE_NS, "text-properties")[0];
    if (text) {
      const weight = attr(text, FO_NS, "font-weight");
      if (weight === "bold" || weight === "700" || weight === "800") props.bold = true;
      if (attr(text, FO_NS, "font-style") === "italic") props.italic = true;
      if (attr(text, STYLE_NS, "text-underline-style")) props.underline = true;
      if (attr(text, STYLE_NS, "text-line-through-style")) props.strike = true;
      const color = attr(text, FO_NS, "color");
      if (color) props.color = color;
      const size = attr(text, FO_NS, "font-size");
      if (size) props.size = size;
    }
    const para = el.getElementsByTagNameNS(STYLE_NS, "paragraph-properties")[0];
    if (para) {
      const align = attr(para, FO_NS, "text-align");
      if (align) props.align = align;
    }
    styles.set(name, props);
  }
  return styles;
}

/** Merged properties of a chain of style names, the document's own cascade. */
function resolve(styles: Map<string, StyleProps>, names: (string | null)[]): StyleProps {
  const out: StyleProps = {};
  for (const name of names) {
    if (!name) continue;
    const props = styles.get(name);
    if (props) Object.assign(out, props);
  }
  return out;
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cssOf(props: StyleProps): string {
  const rules: string[] = [];
  if (props.bold) rules.push("font-weight:700");
  if (props.italic) rules.push("font-style:italic");
  if (props.underline) rules.push("text-decoration:underline");
  if (props.strike) rules.push("text-decoration:line-through");
  if (props.color) rules.push(`color:${props.color}`);
  if (props.size) rules.push(`font-size:${props.size}`);
  if (props.align) rules.push(`text-align:${props.align}`);
  return rules.join(";");
}

function inlineHtml(node: Node, styles: Map<string, StyleProps>): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out += escapeText(child.textContent ?? "");
      return;
    }
    if (child.nodeType !== 1) return;
    const el = child as Element;
    if (el.namespaceURI === TEXT_NS && el.localName === "s") {
      // `text:s` is one or more spaces (its c attribute is the count).
      out += " ".repeat(Number(attr(el, TEXT_NS, "c") ?? "1"));
      return;
    }
    if (el.namespaceURI === TEXT_NS && el.localName === "tab") {
      out += " ";
      return;
    }
    if (el.namespaceURI === TEXT_NS && el.localName === "line-break") {
      out += "<br>";
      return;
    }
    const inner = inlineHtml(el, styles);
    const props = resolve(styles, [attr(el, TEXT_NS, "style-name")]);
    const css = cssOf(props);
    out += css ? `<span style="${css}">${inner}</span>` : inner;
  });
  return out;
}

function paragraphHtml(el: Element, styles: Map<string, StyleProps>, tag = "p"): string {
  const props = resolve(styles, [attr(el, TEXT_NS, "style-name")]);
  const css = cssOf(props);
  return `<${tag}${css ? ` style="${css}"` : ""}>${inlineHtml(el, styles)}</${tag}>`;
}

function listHtml(el: Element, styles: Map<string, StyleProps>): string {
  const items = [...el.children].filter(
    (child) => child.namespaceURI === TEXT_NS && child.localName === "list-item",
  );
  const body = items
    .map((item) => {
      const blocks = [...item.children]
        .filter((child) => child.namespaceURI === TEXT_NS)
        .map((child) => (child.localName === "h" ? headingHtml(child, styles) : paragraphHtml(child, styles)))
        .join("");
      return `<li>${blocks}</li>`;
    })
    .join("");
  return `<ul>${body}</ul>`;
}

function headingHtml(el: Element, styles: Map<string, StyleProps>): string {
  const level = Math.min(6, Math.max(1, Number(attr(el, TEXT_NS, "outline-level") ?? "1") || 1));
  return paragraphHtml(el, styles, `h${level}`);
}

function tableHtml(el: Element, styles: Map<string, StyleProps>): string {
  const rows = [...el.children].filter(
    (child) => child.namespaceURI === TABLE_NS && child.localName === "table-row",
  );
  const body = rows
    .map((row) => {
      const cells = [...row.children].filter(
        (child) =>
          child.namespaceURI === TABLE_NS &&
          (child.localName === "table-cell" || child.localName === "covered-table-cell"),
      );
      const html = cells
        .map((cell) => {
          const span = Number(attr(cell, TABLE_NS, "number-columns-spanned") ?? "1") || 1;
          const attrs = span > 1 ? ` colspan="${span}"` : "";
          const blocks = [...cell.children]
            .filter((child) => child.namespaceURI === TEXT_NS)
            .map((child) => (child.localName === "h" ? headingHtml(child, styles) : paragraphHtml(child, styles)))
            .join("");
          return `<td${attrs}>${blocks}</td>`;
        })
        .join("");
      return `<tr>${html}</tr>`;
    })
    .join("");
  return `<table><tbody>${body}</tbody></table>`;
}

function bodyHtml(root: Element, styles: Map<string, StyleProps>): string {
  return [...root.children]
    .map((child) => {
      if (child.namespaceURI === TEXT_NS) {
        if (child.localName === "h") return headingHtml(child, styles);
        if (child.localName === "p") return paragraphHtml(child, styles);
        if (child.localName === "list") return listHtml(child, styles);
      }
      if (child.namespaceURI === TABLE_NS && child.localName === "table") {
        return tableHtml(child, styles);
      }
      return "";
    })
    .join("");
}

/** The document's text and structure, as HTML, with its own styles applied. */
export async function renderOdt(arrayBuffer: ArrayBuffer, host: HTMLElement): Promise<void> {
  const { default: JSZipCtor } = (await import("jszip")) as { default: typeof JSZip };
  const zip = await JSZipCtor.loadAsync(arrayBuffer);
  const parser = new DOMParser();
  const styles = new Map<string, StyleProps>();
  const stylesFile = zip.file("styles.xml");
  if (stylesFile) {
    // Document-wide styles first: automatic ones override them below.
    const doc = parser.parseFromString(await stylesFile.async("string"), "application/xml");
    for (const [name, props] of readStyles(doc)) styles.set(name, props);
  }
  const contentFile = zip.file("content.xml");
  if (!contentFile) throw new Error("not an OpenDocument file");
  const content = parser.parseFromString(await contentFile.async("string"), "application/xml");
  for (const [name, props] of readStyles(content)) styles.set(name, props);
  const body = content.getElementsByTagNameNS(
    "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "text",
  )[0];
  if (!body) throw new Error("no document body");
  // ODF keeps a table's borders in its cell styles, which this reader does not
  // read: the wrapper lets the pane draw a plain grid so columns stay legible.
  host.innerHTML = `<div class="odt">${bodyHtml(body, styles)}</div>`;
}
