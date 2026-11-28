/**
 * A presentation, drawn as the slides: the reader (`pptx-preview`) lays every
 * slide out at its own size with the deck's own fills, fonts and pictures, and
 * stacks them in a column.
 *
 * The slides are laid out at a fixed size and the pane scales them as a whole
 * (`zoom`), so what the reader sees is the slide's arrangement, not a re-flow of
 * it — a presentation is placed, not written.
 *
 * Loaded on demand: an app that never opens a deck ships none of this — and the
 * reader carries a chart library, which is the bulk of that chunk.
 */
export const SLIDE_WIDTH = 960;
export const SLIDE_HEIGHT = 540;

export type SlideViewer = { destroy: () => void };

/**
 * Drop `[Content_Types].xml` entries that name parts the package does not have.
 * The OPC spec forbids them, PowerPoint ignores them — and a deck generator
 * (pptxgenjs) writes them: it declares three slide masters and ships one, which
 * is enough for the reader to abort and draw an empty frame with no error at
 * all. The same package minus those lines is a valid deck.
 */
async function withoutDanglingParts(arrayBuffer: ArrayBuffer): Promise<ArrayBuffer> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(arrayBuffer);
  const types = zip.file("[Content_Types].xml");
  if (!types) return arrayBuffer;
  let dropped = false;
  const cleaned = (await types.async("string")).replace(
    /<Override\b[^>]*PartName="([^"]+)"[^>]*\/>/g,
    (tag, part: string) => {
      if (zip.file(part.replace(/^\//, ""))) return tag;
      dropped = true;
      return "";
    },
  );
  if (!dropped) return arrayBuffer;
  zip.file("[Content_Types].xml", cleaned);
  return zip.generateAsync({ type: "arraybuffer" });
}

export async function renderPptx(
  arrayBuffer: ArrayBuffer,
  host: HTMLElement,
): Promise<SlideViewer> {
  const deck = await withoutDanglingParts(arrayBuffer);
  const { init } = await import("pptx-preview");
  const viewer = init(host, {
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    // Every slide at once: a change is read down the deck, not one slide at a
    // time behind arrow buttons.
    mode: "list",
  });
  await viewer.preview(deck);
  return { destroy: () => viewer.destroy() };
}
