import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { showToast } from "../lib/toast";
import { gitBlobInfo, gitBlobUrl, type GitBlobInfo } from "../lib/gitBlob";
import { toRepoAbsolutePath } from "../lib/gitFileTree";
import { useT } from "../lib/i18n";
import { OfficePreview, type OfficeKind } from "./OfficePreview";
import styles from "./MediaDiff.module.css";

/** One side of a change: a revision's copy of the file, or the working copy. */
type Side = { key: "before" | "after"; rev: string | null; path: string };

/** How a file is drawn: by its own type where the pane has a reader for it. */
type Kind = "image" | "video" | "audio" | "pdf" | OfficeKind | "file";

/** The office formats the pane reads itself; anything else stays a card. */
const OFFICE_KIND: Record<string, OfficeKind> = {
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  odt: "odt",
  // The binary predecessors: their text is read, their layout is not.
  doc: "doc",
  ppt: "ppt",
};

function kindOf(path: string, mime: string | null): Kind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const office = OFFICE_KIND[ext];
  if (office) return office;
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

/** `1234567` → `1.2 MB`: a document's size, in units every locale reads. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A changed file that has no text to diff, read as what it is: a picture beside
 * the picture it replaces, a video with its player, a PDF in the browser's own
 * viewer. The office formats no browser renders are a card that says so and
 * hands over the file — pretending to preview them would be a lie in the pane.
 *
 * Same shell as the text diff it stands in for: the path above, the two sides
 * side by side, and one column when the pane is too narrow for two.
 */
export function MediaDiff({
  sessionId,
  root,
  path,
  signature = "",
  compare,
}: {
  sessionId: string;
  /** The folder git talks in: `path` is relative to it. */
  root: string;
  path: string;
  /** Git's numbers for a working change: a different value means read it again. */
  signature?: string;
  /** A commit's pair of revisions — the parent's copy and its own. */
  compare?: { from: string | null; fromPath?: string; to: string };
}) {
  const t = useT();
  // Pulled out one by one: an object literal from the parent is a new identity
  // on every render, and the effect below must not re-run for it.
  const fromRev = compare?.from ?? null;
  const fromPath = compare?.fromPath ?? path;
  const toRev = compare?.to ?? null;

  const sides = useMemo<Side[]>(() => {
    if (toRev !== null) {
      const list: Side[] = [];
      // A root commit has no parent, so there is no other side to show.
      if (fromRev !== null) list.push({ key: "before", rev: fromRev, path: fromPath });
      list.push({ key: "after", rev: toRev, path });
      return list;
    }
    // The working copy against HEAD — the same pair the text diff reads.
    return [
      { key: "before", rev: "HEAD", path },
      { key: "after", rev: null, path },
    ];
  }, [fromPath, fromRev, path, toRev]);

  /**
   * What the sides hold, tagged with the pair it describes: a click on the next
   * file renders once before the effect runs, and the previous file's answer
   * must not draw its picture under the new name — that request is a 404 and a
   * broken frame.
   */
  const sidesKey = `${sides.map((side) => `${side.rev ?? ""}:${side.path}`).join("|")}|${signature}`;
  const [loaded, setLoaded] = useState<{ key: string; infos?: GitBlobInfo[]; failed?: boolean } | null>(null);
  const ready = loaded?.key === sidesKey ? loaded : null;
  const infos = ready?.infos ?? null;
  const failed = ready?.failed === true;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await Promise.all(
          sides.map((side) => gitBlobInfo(sessionId, side.path, side.rev)),
        );
        if (alive) setLoaded({ key: sidesKey, infos: next });
      } catch {
        if (alive) setLoaded({ key: sidesKey, failed: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, sides, sidesKey]);

  /** The format is the same on both sides: it is the file's own extension. */
  const kind = kindOf(path, infos?.find((info) => info.mime)?.mime ?? null);

  const openOnDisk = async (side: Side) => {
    try {
      const result = await api.openPath(toRepoAbsolutePath(root, side.path));
      if (!result.ok) showToast(t("git.openFileFailed"));
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err));
    }
  };

  const body = (side: Side, info: GitBlobInfo) => {
    const label = t(side.key === "before" ? "git.previewBefore" : "git.previewAfter");
    if (!info.exists) return <div className={styles.absent}>{t("git.previewAbsent")}</div>;
    const url = gitBlobUrl(sessionId, side.path, {
      rev: side.rev,
      // A working copy is read again whenever git reports the file changed.
      sig: side.rev === null ? signature : undefined,
    });
    if (kind === "image") {
      return <img className={styles.picture} src={url} alt={`${side.path} · ${label}`} />;
    }
    if (kind === "video") {
      return <video className={styles.media} src={url} controls preload="metadata" />;
    }
    if (kind === "audio") {
      return (
        <div className={styles.center}>
          <audio className={styles.audio} src={url} controls preload="metadata" />
        </div>
      );
    }
    if (kind === "pdf") {
      return <iframe className={styles.frame} src={url} title={`${side.path} · ${label}`} />;
    }
    if (kind === "docx" || kind === "pptx" || kind === "xlsx" || kind === "odt" || kind === "doc" || kind === "ppt") {
      return <OfficePreview url={url} bytes={info.size} kind={kind} />;
    }
    const name = side.path.split("/").pop() ?? side.path;
    return (
      <div className={styles.center}>
        <div className={styles.card}>
          <span className={styles.cardName} title={side.path}>
            {name}
          </span>
          <span className={styles.cardNote}>{t("git.previewNoView")}</span>
          <div className={styles.cardActions}>
            <a className={styles.action} href={url} download={name}>
              {t("git.previewDownload")}
            </a>
            {side.rev === null ? (
              <button type="button" className={styles.action} onClick={() => void openOnDisk(side)}>
                {t("git.openFile")}
              </button>
            ) : null}
          </div>
          <span className={styles.cardSize}>{formatSize(info.size)}</span>
        </div>
      </div>
    );
  };

  return (
    <section className={styles.diff} data-media-diff={path} aria-label={path}>
      <header className={styles.bar}>
        <span className={styles.path} title={path}>
          {path}
        </span>
      </header>
      {failed ? (
        <div className={styles.note}>{t("git.diffLoadFailed")}</div>
      ) : infos === null ? (
        <div className={styles.note} role="status">
          {t("common.loading")}
        </div>
      ) : (
        /* Only the sides the version actually has: an added file is one column
           of itself, not a picture beside an empty half — the same rule the
           text diff follows for a file git has never seen. */
        <div className={styles.sides} data-sides={sides.filter((_, index) => infos[index]!.exists).length}>
          {sides.map((side, index) =>
            infos[index]!.exists ? (
              <figure className={styles.side} key={side.key}>
                <figcaption className={styles.caption}>
                  {t(side.key === "before" ? "git.previewBefore" : "git.previewAfter")}
                </figcaption>
                {body(side, infos[index]!)}
              </figure>
            ) : null,
          )}
        </div>
      )}
    </section>
  );
}
