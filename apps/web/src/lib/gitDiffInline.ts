import type { ParsedDiffLine, ParsedHunk } from "./gitDiffParse";

export type InlineSegment = { type: "equal" | "insert" | "delete"; text: string };

export type SideBySideRow = {
  oldLineNo: number | null;
  newLineNo: number | null;
  oldText: string | null;
  newText: string | null;
  kind: "context" | "delete" | "insert" | "change";
};

export type UnifiedDiffRow =
  | { kind: "line"; line: ParsedDiffLine; oldSegments?: InlineSegment[]; newSegments?: InlineSegment[] }
  | { kind: "change"; oldLine: ParsedDiffLine; newLine: ParsedDiffLine; oldSegments: InlineSegment[]; newSegments: InlineSegment[] };

const INLINE_DIFF_MAX_TOKENS = 400;

export function tokenizeDiffLine(text: string): string[] {
  const tokens: string[] = [];
  const re = /\s+|[^\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) tokens.push(match[0]);
  return tokens.length ? tokens : text ? [text] : [];
}

function mergeSegments(segments: InlineSegment[]): InlineSegment[] {
  const merged: InlineSegment[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.type === seg.type) prev.text += seg.text;
    else merged.push({ ...seg });
  }
  return merged;
}

function segmentsFromTokens(tokens: string[], type: "insert" | "delete"): InlineSegment[] {
  if (tokens.length === 0) return [];
  return [{ type, text: tokens.join("") }];
}

function lcsDiffTokens(a: string[], b: string[]): { old: InlineSegment[]; new: InlineSegment[] } {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  const oldParts: InlineSegment[] = [];
  const newParts: InlineSegment[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      oldParts.unshift({ type: "equal", text: a[i - 1]! });
      newParts.unshift({ type: "equal", text: b[j - 1]! });
      i -= 1;
      j -= 1;
      continue;
    }
    if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      newParts.unshift({ type: "insert", text: b[j - 1]! });
      j -= 1;
      continue;
    }
    if (i > 0) {
      oldParts.unshift({ type: "delete", text: a[i - 1]! });
      i -= 1;
    }
  }

  return { old: mergeSegments(oldParts), new: mergeSegments(newParts) };
}

export function diffInlineSegments(oldText: string, newText: string): { old: InlineSegment[]; new: InlineSegment[] } {
  if (oldText === newText) {
    return {
      old: [{ type: "equal", text: oldText }],
      new: [{ type: "equal", text: newText }],
    };
  }

  const a = tokenizeDiffLine(oldText);
  const b = tokenizeDiffLine(newText);
  if (a.length > INLINE_DIFF_MAX_TOKENS || b.length > INLINE_DIFF_MAX_TOKENS) {
    return {
      old: [{ type: "delete", text: oldText }],
      new: [{ type: "insert", text: newText }],
    };
  }

  return lcsDiffTokens(a, b);
}

export function buildSideBySideRows(hunk: ParsedHunk): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const lines = hunk.lines;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const content = line.text.length > 0 ? line.text.slice(1) : "";

    if (line.kind === "ctx") {
      rows.push({
        oldLineNo: oldNo,
        newLineNo: newNo,
        oldText: content,
        newText: content,
        kind: "context",
      });
      oldNo += 1;
      newNo += 1;
      i += 1;
      continue;
    }

    if (line.kind === "del") {
      const dels: string[] = [];
      while (i < lines.length && lines[i]?.kind === "del") {
        dels.push(lines[i]!.text.length > 0 ? lines[i]!.text.slice(1) : "");
        i += 1;
      }
      const adds: string[] = [];
      while (i < lines.length && lines[i]?.kind === "add") {
        adds.push(lines[i]!.text.length > 0 ? lines[i]!.text.slice(1) : "");
        i += 1;
      }

      const count = Math.max(dels.length, adds.length);
      for (let j = 0; j < count; j += 1) {
        const oldText = dels[j] ?? null;
        const newText = adds[j] ?? null;
        let kind: SideBySideRow["kind"] = "change";
        if (oldText !== null && newText === null) kind = "delete";
        else if (oldText === null && newText !== null) kind = "insert";

        rows.push({
          oldLineNo: oldText !== null ? oldNo : null,
          newLineNo: newText !== null ? newNo : null,
          oldText,
          newText,
          kind,
        });

        if (oldText !== null) oldNo += 1;
        if (newText !== null) newNo += 1;
      }
      continue;
    }

    if (line.kind === "add") {
      rows.push({
        oldLineNo: null,
        newLineNo: newNo,
        oldText: null,
        newText: content,
        kind: "insert",
      });
      newNo += 1;
      i += 1;
    }
  }

  return rows;
}

export function buildUnifiedDiffRows(lines: ParsedDiffLine[]): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.kind !== "del") {
      if (line.kind === "add") {
        const text = line.text.length > 0 ? line.text.slice(1) : "";
        rows.push({
          kind: "line",
          line,
          newSegments: segmentsFromTokens(tokenizeDiffLine(text), "insert"),
        });
      } else {
        rows.push({ kind: "line", line });
      }
      i += 1;
      continue;
    }

    const dels: ParsedDiffLine[] = [];
    while (i < lines.length && lines[i]?.kind === "del") {
      dels.push(lines[i]!);
      i += 1;
    }
    const adds: ParsedDiffLine[] = [];
    while (i < lines.length && lines[i]?.kind === "add") {
      adds.push(lines[i]!);
      i += 1;
    }

    const count = Math.max(dels.length, adds.length);
    for (let j = 0; j < count; j += 1) {
      const oldLine = dels[j];
      const newLine = adds[j];
      if (oldLine && newLine) {
        const oldText = oldLine.text.length > 0 ? oldLine.text.slice(1) : "";
        const newText = newLine.text.length > 0 ? newLine.text.slice(1) : "";
        const { old, new: next } = diffInlineSegments(oldText, newText);
        rows.push({ kind: "change", oldLine, newLine, oldSegments: old, newSegments: next });
      } else if (oldLine) {
        const oldText = oldLine.text.length > 0 ? oldLine.text.slice(1) : "";
        rows.push({
          kind: "line",
          line: oldLine,
          oldSegments: segmentsFromTokens(tokenizeDiffLine(oldText), "delete"),
        });
      } else if (newLine) {
        const newText = newLine.text.length > 0 ? newLine.text.slice(1) : "";
        rows.push({
          kind: "line",
          line: newLine,
          newSegments: segmentsFromTokens(tokenizeDiffLine(newText), "insert"),
        });
      }
    }
  }

  return rows;
}
