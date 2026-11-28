import { useEffect, useRef, useState } from "react";
import { renderDocx } from "../lib/docxPreview";
import { docText, pptText } from "../lib/legacyOffice";
import { renderOdt } from "../lib/odtPreview";
import { SLIDE_WIDTH, renderPptx, type SlideViewer } from "../lib/pptxPreview";
import { renderXlsx } from "../lib/xlsxPreview";
import { useT } from "../lib/i18n";
import styles from "./MediaDiff.module.css";

/**
 * A document past this size is not drawn: the pane is a diff, and a file of tens
 * of megabytes is a reader's job, not a diff's. The file still downloads.
 */
const MAX_BYTES = 20 * 1024 * 1024;

/** The office formats, and what the pane can honestly do with each of them. */
export type OfficeKind = "docx" | "pptx" | "xlsx" | "odt" | "doc" | "ppt";

/** Formats no browser lays out: their text is read, their layout is not. */
const TEXT_ONLY: ReadonlySet<OfficeKind> = new Set<OfficeKind>(["doc", "ppt"]);

type Loaded = { key: string; ok: true } | { key: string; ok: false };

/**
 * One side of an office-format change, read by the format's own reader: Word
 * keeps its styles through `docx-preview`, slides keep their placement through
 * `pptx-preview`, a sheet keeps its grid and cell styles through ExcelJS, and an
 * ODF document its named styles through the small reader in `odtPreview`.
 *
 * The two binary formats of the same names — `.doc` and `.ppt` — have no reader
 * that could lay them out in a browser: what a reader gets is their text, said so
 * above it, and the file itself stays a download.
 */
export function OfficePreview({
  url,
  bytes,
  kind,
}: {
  url: string;
  /** What git says the file weighs: a document no pane can draw is not fetched. */
  bytes: number;
  kind: OfficeKind;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** The extracted text of `.doc`/`.ppt`, which have no layout to draw. */
  const [text, setText] = useState<string | null>(null);
  /** Slides are laid out at a fixed size; the pane scales the whole deck. */
  const [scale, setScale] = useState(1);
  const key = `${kind}\n${url}`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let viewer: SlideViewer | null = null;
    setLoaded(null);
    setText(null);
    if (bytes > MAX_BYTES) {
      setLoaded({ key, ok: false });
      return;
    }
    void (async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(res.statusText || "read failed");
        const arrayBuffer = await res.arrayBuffer();
        if (kind === "docx") await renderDocx(arrayBuffer, host);
        else if (kind === "pptx") viewer = await renderPptx(arrayBuffer, host);
        else if (kind === "xlsx") await renderXlsx(arrayBuffer, host);
        else if (kind === "odt") await renderOdt(arrayBuffer, host);
        else if (alive) {
          const extracted = kind === "doc" ? await docText(arrayBuffer) : await pptText(arrayBuffer);
          if (alive) setText(extracted);
        }
        if (alive) setLoaded({ key, ok: true });
      } catch {
        if (alive) setLoaded({ key, ok: false });
      }
    })();
    return () => {
      alive = false;
      viewer?.destroy();
      host.replaceChildren();
    };
  }, [bytes, key, kind, url]);

  // The deck is drawn 960px wide whatever the pane is; measure the pane and
  // scale the whole thing down, keeping every slide's arrangement intact.
  useEffect(() => {
    if (kind !== "pptx") return;
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const width = frame.clientWidth - 2;
      if (width > 0) setScale(Math.min(1, width / SLIDE_WIDTH));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [kind, loaded]);

  if (loaded?.key === key && !loaded.ok) {
    return <div className={styles.absent}>{t("git.previewDocFailed")}</div>;
  }
  const drawing = loaded?.key !== key;
  return (
    <div className={styles.office} ref={frameRef} data-office-preview={kind}>
      {drawing ? (
        <div className={styles.absent} role="status">
          {t("common.loading")}
        </div>
      ) : null}
      {text !== null ? (
        <>
          {TEXT_ONLY.has(kind) ? (
            <div className={styles.textNote}>{t("git.previewTextOnly")}</div>
          ) : null}
          <pre className={styles.docText}>{text || t("git.previewTextEmpty")}</pre>
        </>
      ) : (
        <div
          className={kind === "pptx" ? styles.slidesZoom : styles.officeDoc}
          style={kind === "pptx" ? { zoom: scale } : undefined}
          ref={hostRef}
        />
      )}
    </div>
  );
}
