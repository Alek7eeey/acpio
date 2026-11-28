/**
 * A spreadsheet drawn as a grid: every sheet of the workbook, its columns as
 * wide as the file says, and each cell with the document's own font, fill,
 * border and alignment, plus the text its number format produces.
 *
 * The reader (ExcelJS) is loaded on demand and is the heavy one — a workbook is
 * a real model of cells, styles and formulas, not a string of XML.
 */
const MAX_ROWS = 400;
const MAX_COLS = 40;

type Colour = { argb?: string } | undefined;

function colorOf(value: Colour): string | null {
  const argb = value?.argb;
  if (!argb || argb.length < 8) return null;
  const alpha = Number.parseInt(argb.slice(0, 2), 16);
  if (alpha === 0) return null;
  return `#${argb.slice(2)}`;
}

/** Excel's column width unit is not a pixel; this is the usual approximation. */
function pxWidth(width: number | undefined): string {
  const chars = width ?? 10;
  return `${Math.round(Math.min(260, Math.max(36, chars * 7 + 5)))}px`;
}

/** The address of a merged range, as the cell that starts it reports it. */
function mergeRanges(sheet: { model?: { merges?: string[] } }): string[] {
  return sheet.model?.merges ?? [];
}

function isInsideMerge(addr: string, ranges: string[], starts: Set<string>): { skip: boolean; span?: string } {
  if (starts.has(addr)) {
    const range = ranges.find((item) => item.split(":")[0] === addr);
    if (range && range.includes(":")) return { skip: false, span: range };
    return { skip: false };
  }
  for (const range of ranges) {
    const [from, to] = range.split(":");
    if (!from || !to) continue;
    if (covers(address(addr), address(from), address(to))) return { skip: true };
  }
  return { skip: false };
}

function address(addr: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(addr);
  if (!match) return { col: 0, row: 0 };
  const [, letters, digits] = match;
  let col = 0;
  for (const ch of letters!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(digits) };
}

function covers(cell: { col: number; row: number }, from: { col: number; row: number }, to: { col: number; row: number }) {
  return cell.col >= from.col && cell.col <= to.col && cell.row >= from.row && cell.row <= to.row;
}

/** The bytes of a worksheet as a table the pane can scroll. */
export async function renderXlsx(arrayBuffer: ArrayBuffer, host: HTMLElement): Promise<void> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer as unknown as ArrayBuffer);
  const doc = document.implementation.createHTMLDocument("");

  for (const sheet of workbook.worksheets) {
    const heading = doc.createElement("h4");
    heading.textContent = sheet.name;
    heading.setAttribute("style", "margin:10px 0 4px;font:600 0.8rem var(--font-mono);color:var(--text-secondary)");
    host.append(heading);

    const table = doc.createElement("table");
    table.setAttribute("style", "border-collapse:collapse;font:0.75rem var(--font-mono)");

    const merges = mergeRanges(sheet);
    const starts = new Set(merges.map((range) => range.split(":")[0] ?? ""));
    const rows = Math.min(sheet.rowCount || 0, MAX_ROWS);
    const cols = Math.min(sheet.columnCount || 0, MAX_COLS);

    for (let r = 1; r <= rows; r += 1) {
      const row = sheet.getRow(r);
      const tr = doc.createElement("tr");
      for (let c = 1; c <= cols; c += 1) {
        const cell = row.getCell(c);
        const addr = cell.address;
        const merge = isInsideMerge(addr, merges, starts);
        if (merge.skip) continue;
        const td = doc.createElement("td");
        const style: string[] = ["padding:2px 6px", "border:1px solid var(--border-soft)", "vertical-align:top"];
        if (merge.span) {
          const [from, to] = merge.span.split(":");
          const a = address(from!);
          const b = address(to!);
          if (b.col > a.col) td.colSpan = b.col - a.col + 1;
          if (b.row > a.row) td.rowSpan = b.row - a.row + 1;
        }
        const font = cell.font;
        if (font) {
          if (font.bold) style.push("font-weight:700");
          if (font.italic) style.push("font-style:italic");
          const color = colorOf(font.color as Colour);
          if (color) style.push(`color:${color}`);
          if (font.size) style.push(`font-size:${font.size}pt`);
        }
        const fill = cell.fill as { type?: string; fgColor?: Colour } | undefined;
        const background = fill?.type === "pattern" ? colorOf(fill.fgColor) : null;
        if (background) style.push(`background:${background}`);
        const alignment = cell.alignment;
        if (alignment?.horizontal) style.push(`text-align:${alignment.horizontal === "centerContinuous" ? "center" : alignment.horizontal}`);
        const border = cell.border;
        if (border?.top) style.push(`border-top:1px solid ${colorOf(border.top.color as Colour) ?? "var(--border)"}`);
        if (border?.bottom) style.push(`border-bottom:1px solid ${colorOf(border.bottom.color as Colour) ?? "var(--border)"}`);
        if (border?.left) style.push(`border-left:1px solid ${colorOf(border.left.color as Colour) ?? "var(--border)"}`);
        if (border?.right) style.push(`border-right:1px solid ${colorOf(border.right.color as Colour) ?? "var(--border)"}`);
        td.setAttribute("style", style.join(";"));
        td.textContent = cell.text ?? "";
        tr.append(td);
      }
      table.append(tr);
    }
    // Column widths are the file's: they are what makes a sheet readable.
    const colgroup = doc.createElement("colgroup");
    for (let c = 1; c <= cols; c += 1) {
      const col = doc.createElement("col");
      const width = sheet.getColumn(c).width;
      col.setAttribute("style", `width:${pxWidth(width)}`);
      colgroup.append(col);
    }
    table.prepend(colgroup);
    host.append(table);
  }
}
