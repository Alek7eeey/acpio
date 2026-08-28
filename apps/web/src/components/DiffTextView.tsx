import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import {
  buildSideBySideRows,
  buildUnifiedDiffRows,
  diffInlineSegments,
  type InlineSegment,
  type SideBySideRow,
} from "../lib/gitDiffInline";
import { isUnifiedDiff, parseUnifiedDiff, type ParsedDiffFile, type ParsedDiffLine } from "../lib/gitDiffParse";
import styles from "./DiffTextView.module.css";

const EXPAND_CHUNK = 100;
const DIFF_VIEW_KEY = "acpio.gitDiffView.v1";

export type DiffContextSource = {
  sessionId: string;
  mode: "working" | "commit";
  commitRev?: string;
};

type DiffViewMode = "unified" | "split";

type HunkExpansion = {
  aboveLines: string[];
  belowLines: string[];
  totalLines?: number;
};

function readDiffViewMode(): DiffViewMode {
  try {
    const raw = localStorage.getItem(DIFF_VIEW_KEY);
    if (raw === "split" || raw === "unified") return raw;
  } catch {
    /* ignore */
  }
  return "unified";
}

function splitPlain(text: string) {
  return text.split("\n").map((line, idx) => (
    <div key={idx} className={styles.line}>
      {line === "" ? "\u00A0" : line}
    </div>
  ));
}

function lineClass(line: ParsedDiffLine) {
  if (line.kind === "file") return `${styles.line} ${styles.file}`;
  if (line.kind === "hunk") return `${styles.line} ${styles.hunk}`;
  if (line.kind === "add") return `${styles.line} ${styles.add}`;
  if (line.kind === "del") return `${styles.line} ${styles.del}`;
  return styles.line;
}

function splitCellClass(kind: SideBySideRow["kind"], side: "old" | "new") {
  if (kind === "context") return `${styles.splitCell} ${styles.splitCtx}`;
  if (kind === "delete" && side === "old") return `${styles.splitCell} ${styles.splitDel}`;
  if (kind === "insert" && side === "new") return `${styles.splitCell} ${styles.splitAdd}`;
  if (kind === "change") {
    return `${styles.splitCell} ${side === "old" ? styles.splitDel : styles.splitAdd}`;
  }
  return `${styles.splitCell} ${styles.splitEmpty}`;
}

function renderInlineSegments(segments: InlineSegment[] | undefined, side: "old" | "new", plain: string) {
  if (!segments?.length) return plain === "" ? "\u00A0" : plain;
  return segments.map((seg, idx) => {
    if (seg.type === "equal") return <span key={idx}>{seg.text}</span>;
    if (seg.type === "delete" && side === "old") {
      return (
        <span key={idx} className={styles.wordDel}>
          {seg.text}
        </span>
      );
    }
    if (seg.type === "insert" && side === "new") {
      return (
        <span key={idx} className={styles.wordAdd}>
          {seg.text}
        </span>
      );
    }
    return <span key={idx}>{seg.text}</span>;
  });
}

function InlineDiffLine({
  line,
  side,
  segments,
}: {
  line: ParsedDiffLine;
  side: "old" | "new";
  segments?: InlineSegment[];
}) {
  const text = line.text.length > 0 ? line.text.slice(1) : "";
  return (
    <div className={lineClass(line)}>
      {renderInlineSegments(segments, side, text)}
    </div>
  );
}

function DiffLineRow({ line, keyId }: { line: ParsedDiffLine; keyId: string }) {
  return (
    <div key={keyId} className={lineClass(line)}>
      {line.text === "" ? "\u00A0" : line.text}
    </div>
  );
}

function ContextLines({ lines, prefix }: { lines: string[]; prefix: string }) {
  return lines.map((text, idx) => (
    <div key={`${prefix}-${idx}`} className={`${styles.line} ${styles.ctx}`}>
      {text === "" ? " " : ` ${text}`}
    </div>
  ));
}

function SplitContextLines({ lines, prefix }: { lines: string[]; prefix: string }) {
  return lines.map((text, idx) => (
    <div key={`${prefix}-${idx}`} className={styles.splitRow}>
      <div className={styles.splitGutter} aria-hidden />
      <div className={`${styles.splitCell} ${styles.splitCtx}`}>{text === "" ? "\u00A0" : text}</div>
      <div className={styles.splitGutter} aria-hidden />
      <div className={`${styles.splitCell} ${styles.splitCtx}`}>{text === "" ? "\u00A0" : text}</div>
    </div>
  ));
}

function ExpandUpRow({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <div className={`${styles.expandRow} ${styles.expandRowUp}`}>
      <button
        type="button"
        className={styles.expandBtn}
        disabled={busy}
        aria-label={t("git.diffExpandUp")}
        title={t("git.diffExpandUpChunk", { count: EXPAND_CHUNK })}
        onClick={onClick}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span className={styles.expandRule} aria-hidden />
    </div>
  );
}

function ExpandDownRow({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <div className={`${styles.expandRow} ${styles.expandRowDown}`}>
      <span className={styles.expandRule} aria-hidden />
      <button
        type="button"
        className={styles.expandBtn}
        disabled={busy}
        aria-label={t("git.diffExpandDown")}
        title={t("git.diffExpandDownChunk", { count: EXPAND_CHUNK })}
        onClick={onClick}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

function DiffViewToolbar({
  mode,
  onChange,
}: {
  mode: DiffViewMode;
  onChange: (mode: DiffViewMode) => void;
}) {
  const t = useT();
  return (
    <div className={styles.viewToolbar} role="toolbar" aria-label={t("git.diffViewMode")}>
      <button
        type="button"
        className={`${styles.viewBtn}${mode === "unified" ? ` ${styles.viewBtnActive}` : ""}`}
        aria-pressed={mode === "unified"}
        onClick={() => onChange("unified")}
      >
        {t("git.diffViewUnified")}
      </button>
      <button
        type="button"
        className={`${styles.viewBtn}${mode === "split" ? ` ${styles.viewBtnActive}` : ""}`}
        aria-pressed={mode === "split"}
        onClick={() => onChange("split")}
      >
        {t("git.diffViewSplit")}
      </button>
    </div>
  );
}

function SplitDiffRow({ row }: { row: SideBySideRow }) {
  let oldSegments: InlineSegment[] | undefined;
  let newSegments: InlineSegment[] | undefined;
  if (row.oldText !== null && row.newText !== null) {
    const inline = diffInlineSegments(row.oldText, row.newText);
    oldSegments = inline.old;
    newSegments = inline.new;
  } else if (row.oldText !== null) {
    oldSegments = [{ type: "delete", text: row.oldText }];
  } else if (row.newText !== null) {
    newSegments = [{ type: "insert", text: row.newText }];
  }

  return (
    <div className={styles.splitRow}>
      <div className={styles.splitGutter}>{row.oldLineNo ?? ""}</div>
      <div className={splitCellClass(row.kind, "old")}>
        {row.oldText === null ? "\u00A0" : renderInlineSegments(oldSegments, "old", row.oldText)}
      </div>
      <div className={styles.splitGutter}>{row.newLineNo ?? ""}</div>
      <div className={splitCellClass(row.kind, "new")}>
        {row.newText === null ? "\u00A0" : renderInlineSegments(newSegments, "new", row.newText)}
      </div>
    </div>
  );
}

function resolveFilePath(file: ParsedDiffFile) {
  return file.newPath ?? file.oldPath;
}

function hunkKey(fileIndex: number, hunkIndex: number) {
  return `${fileIndex}-${hunkIndex}`;
}

function renderUnifiedHunkBody(lines: ParsedDiffLine[], keyPrefix: string) {
  const rows = buildUnifiedDiffRows(lines);
  const nodes: ReactNode[] = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx]!;
    if (row.kind === "change") {
      nodes.push(
        <InlineDiffLine
          key={`${keyPrefix}-old-${idx}`}
          line={row.oldLine}
          side="old"
          segments={row.oldSegments}
        />,
      );
      nodes.push(
        <InlineDiffLine
          key={`${keyPrefix}-new-${idx}`}
          line={row.newLine}
          side="new"
          segments={row.newSegments}
        />,
      );
      continue;
    }

    const side = row.line.kind === "del" ? "old" : "new";
    nodes.push(
      <InlineDiffLine
        key={`${keyPrefix}-line-${idx}`}
        line={row.line}
        side={side}
        segments={side === "old" ? row.oldSegments : row.newSegments}
      />,
    );
  }

  return nodes;
}

export const DiffTextView = memo(function DiffTextView({
  text,
  contextSource,
}: {
  text: string;
  contextSource?: DiffContextSource;
}) {
  const trimmed = text.trim();
  const [viewMode, setViewMode] = useState<DiffViewMode>(() => readDiffViewMode());
  const [expansions, setExpansions] = useState<Record<string, HunkExpansion>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  useEffect(() => {
    setExpansions({});
    setLoadingKey(null);
  }, [trimmed, contextSource?.sessionId, contextSource?.mode, contextSource?.commitRev]);

  const parsed = useMemo(() => (trimmed && isUnifiedDiff(trimmed) ? parseUnifiedDiff(trimmed) : null), [trimmed]);

  const setMode = useCallback((mode: DiffViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(DIFF_VIEW_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchLines = useCallback(
    async (filePath: string, start: number, end: number) => {
      if (!contextSource) return null;
      return api.gitFileLines(
        contextSource.sessionId,
        filePath,
        start,
        end,
        "new",
        contextSource.mode,
        contextSource.commitRev,
      );
    },
    [contextSource],
  );

  const expandHunk = useCallback(
    async (
      key: string,
      filePath: string,
      direction: "up" | "down",
      newStart: number,
      newEnd: number,
      expansion: HunkExpansion | undefined,
    ) => {
      if (!contextSource || !filePath) return;
      const current = expansion ?? { aboveLines: [], belowLines: [] };

      let start = 0;
      let end = 0;

      if (direction === "up") {
        end = newStart - 1 - current.aboveLines.length;
        if (end < 1) return;
        start = Math.max(1, end - EXPAND_CHUNK + 1);
      } else {
        start = newEnd + 1 + current.belowLines.length;
        const total = current.totalLines;
        if (total !== undefined && start > total) return;
        end = total !== undefined ? Math.min(total, start + EXPAND_CHUNK - 1) : start + EXPAND_CHUNK - 1;
      }

      setLoadingKey(`${key}-${direction}`);
      try {
        const result = await fetchLines(filePath, start, end);
        if (!result) return;
        if (result.lines.length === 0) {
          if (direction === "down" && result.totalLines !== undefined) {
            setExpansions((prev) => {
              const base = prev[key] ?? { aboveLines: [], belowLines: [] };
              return { ...prev, [key]: { ...base, totalLines: result.totalLines } };
            });
          }
          return;
        }
        setExpansions((prev) => {
          const base = prev[key] ?? { aboveLines: [], belowLines: [] };
          const next =
            direction === "up"
              ? {
                  ...base,
                  aboveLines: [...result.lines, ...base.aboveLines],
                  totalLines: result.totalLines,
                }
              : {
                  ...base,
                  belowLines: [...base.belowLines, ...result.lines],
                  totalLines: result.totalLines,
                };
          return { ...prev, [key]: next };
        });
      } finally {
        setLoadingKey(null);
      }
    },
    [contextSource, fetchLines],
  );

  if (!trimmed) return null;

  if (!parsed) {
    return <div className={styles.plain}>{splitPlain(trimmed)}</div>;
  }

  const canExpand = Boolean(contextSource);

  return (
    <div className={styles.root}>
      <DiffViewToolbar mode={viewMode} onChange={setMode} />
      <div className={viewMode === "split" ? styles.diffSplit : styles.diff}>
        {parsed.map((file, fileIndex) => {
          const filePath = resolveFilePath(file);

          return (
            <div key={`file-${fileIndex}`} className={styles.fileBlock}>
              {file.hunks.map((hunk, hunkIndex) => {
                const key = hunkKey(fileIndex, hunkIndex);
                const expansion = expansions[key];
                const aboveCount = expansion?.aboveLines.length ?? 0;
                const belowCount = expansion?.belowLines.length ?? 0;
                const totalLines = expansion?.totalLines;
                const canExpandUp = canExpand && Boolean(filePath) && hunk.newStart - 1 - aboveCount >= 1;
                const canExpandDown =
                  canExpand &&
                  Boolean(filePath) &&
                  (totalLines === undefined || hunk.newEnd + belowCount < totalLines);
                const busyUp = loadingKey === `${key}-up`;
                const busyDown = loadingKey === `${key}-down`;

                return (
                  <div key={`hunk-${fileIndex}-${hunkIndex}`} className={styles.hunkBlock}>
                    {viewMode === "split" ? (
                      <>
                        {expansion?.aboveLines.length ? (
                          <SplitContextLines lines={expansion.aboveLines} prefix={`${key}-above`} />
                        ) : null}
                        {canExpandUp ? (
                          <ExpandUpRow
                            busy={busyUp}
                            onClick={() => void expandHunk(key, filePath!, "up", hunk.newStart, hunk.newEnd, expansion)}
                          />
                        ) : null}
                        <DiffLineRow line={{ kind: "hunk", text: hunk.header }} keyId={`hh-${fileIndex}-${hunkIndex}`} />
                        {buildSideBySideRows(hunk).map((row, rowIndex) => (
                          <SplitDiffRow key={`split-${fileIndex}-${hunkIndex}-${rowIndex}`} row={row} />
                        ))}
                        {canExpandDown ? (
                          <ExpandDownRow
                            busy={busyDown}
                            onClick={() => void expandHunk(key, filePath!, "down", hunk.newStart, hunk.newEnd, expansion)}
                          />
                        ) : null}
                        {expansion?.belowLines.length ? (
                          <SplitContextLines lines={expansion.belowLines} prefix={`${key}-below`} />
                        ) : null}
                      </>
                    ) : (
                      <>
                        {expansion?.aboveLines.length ? (
                          <ContextLines lines={expansion.aboveLines} prefix={`${key}-above`} />
                        ) : null}
                        {canExpandUp ? (
                          <ExpandUpRow
                            busy={busyUp}
                            onClick={() => void expandHunk(key, filePath!, "up", hunk.newStart, hunk.newEnd, expansion)}
                          />
                        ) : null}
                        <DiffLineRow line={{ kind: "hunk", text: hunk.header }} keyId={`hh-${fileIndex}-${hunkIndex}`} />
                        {renderUnifiedHunkBody(hunk.lines, `hl-${fileIndex}-${hunkIndex}`)}
                        {canExpandDown ? (
                          <ExpandDownRow
                            busy={busyDown}
                            onClick={() => void expandHunk(key, filePath!, "down", hunk.newStart, hunk.newEnd, expansion)}
                          />
                        ) : null}
                        {expansion?.belowLines.length ? (
                          <ContextLines lines={expansion.belowLines} prefix={`${key}-below`} />
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
});
