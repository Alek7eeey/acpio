/**
 * A Word document, drawn as the document: the reader (`docx-preview`) parses the
 * package — styles, numbering, tables, pictures, sections — and writes the
 * document's own CSS into the host, so a heading keeps its colour and a table
 * its borders instead of being re-styled by us.
 *
 * Loaded on demand: an app that never opens a document ships none of this.
 */
export async function renderDocx(arrayBuffer: ArrayBuffer, host: HTMLElement): Promise<void> {
  const { renderAsync } = await import("docx-preview");
  await renderAsync(arrayBuffer, host, host, {
    // The pane is a column, not a sheet of paper: the page's width and height
    // are dropped (a document would otherwise be cut off at the pane's edge),
    // while fonts, colours, borders and numbering stay the document's own.
    inWrapper: false,
    ignoreWidth: true,
    ignoreHeight: true,
    breakPages: false,
    // Headers repeat a chapter's title on every page of paper; in one flowing
    // column they would be noise between the paragraphs.
    renderHeaders: false,
    renderFooters: false,
    useBase64URL: true,
  });
}
