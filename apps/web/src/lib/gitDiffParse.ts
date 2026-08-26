export type DiffLineKind = "meta" | "file" | "hunk" | "ctx" | "add" | "del";

export type ParsedDiffLine = {
  kind: DiffLineKind;
  text: string;
};

export type ParsedHunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
  oldEnd: number;
  newEnd: number;
  leadingContext: number;
};

export type ParsedDiffFile = {
  oldPath: string | null;
  newPath: string | null;
  headerLines: ParsedDiffLine[];
  hunks: ParsedHunk[];
};

export type ParsedDiffGap = {
  id: string;
  hiddenCount: number;
  gapStart: number;
  gapEnd: number;
  oldGapStart: number;
  oldGapEnd: number;
  hasOld: boolean;
  hasNew: boolean;
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(line: string): Pick<ParsedHunk, "oldStart" | "oldCount" | "newStart" | "newCount"> | null {
  const match = HUNK_RE.exec(line);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? "1"),
  };
}

function finalizeHunk(header: string, headerMeta: NonNullable<ReturnType<typeof parseHunkHeader>>, rawLines: string[]): ParsedHunk {
  const lines: ParsedDiffLine[] = rawLines.map((text) => {
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    if (text.startsWith(" ")) return { kind: "ctx", text };
    return { kind: "meta", text };
  });

  let oldLine = headerMeta.oldStart;
  let newLine = headerMeta.newStart;
  let leadingContext = 0;
  let sawChange = false;

  for (const line of lines) {
    if (line.kind === "ctx") {
      if (!sawChange) leadingContext += 1;
      oldLine += 1;
      newLine += 1;
    } else if (line.kind === "del") {
      sawChange = true;
      oldLine += 1;
    } else if (line.kind === "add") {
      sawChange = true;
      newLine += 1;
    }
  }

  return {
    header,
    ...headerMeta,
    lines,
    oldEnd: oldLine - 1,
    newEnd: newLine - 1,
    leadingContext,
  };
}

function normalizeDiffPath(raw: string | undefined): string | null {
  if (!raw) return null;
  const path = raw.replace(/^(?:a|b)\//, "").trim();
  if (!path || path === "/dev/null") return null;
  return path;
}

export function parseUnifiedDiff(text: string): ParsedDiffFile[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let currentHunkHeader: string | null = null;
  let currentHunkMeta: ReturnType<typeof parseHunkHeader> = null;
  let currentHunkLines: string[] = [];

  const pushHunk = () => {
    if (!current || !currentHunkHeader || !currentHunkMeta) return;
    current.hunks.push(finalizeHunk(currentHunkHeader, currentHunkMeta, currentHunkLines));
    currentHunkHeader = null;
    currentHunkMeta = null;
    currentHunkLines = [];
  };

  for (const line of trimmed.split("\n")) {
    if (line.startsWith("diff --git ")) {
      pushHunk();
      current = {
        oldPath: null,
        newPath: null,
        headerLines: [{ kind: "meta", text: line }],
        hunks: [],
      };
      files.push(current);
      continue;
    }

    if (!current) {
      if (/^(--- |\+\+\+ |@@ )/.test(line)) {
        current = { oldPath: null, newPath: null, headerLines: [], hunks: [] };
        files.push(current);
      } else {
        continue;
      }
    }

    if (line.startsWith("--- ")) {
      pushHunk();
      current.oldPath = normalizeDiffPath(line.slice(4).split("\t")[0]);
      current.headerLines.push({ kind: "file", text: line });
      continue;
    }

    if (line.startsWith("+++ ")) {
      current.newPath = normalizeDiffPath(line.slice(4).split("\t")[0]);
      current.headerLines.push({ kind: "file", text: line });
      continue;
    }

    if (line.startsWith("@@")) {
      pushHunk();
      currentHunkHeader = line;
      currentHunkMeta = parseHunkHeader(line);
      currentHunkLines = [];
      continue;
    }

    if (currentHunkHeader && currentHunkMeta) {
      currentHunkLines.push(line);
      continue;
    }

    current.headerLines.push({
      kind: line.startsWith("+++") || line.startsWith("---") ? "file" : "meta",
      text: line,
    });
  }

  pushHunk();
  return files;
}

export function buildDiffGaps(file: ParsedDiffFile, fileIndex: number): ParsedDiffGap[] {
  const gaps: ParsedDiffGap[] = [];
  const hasOld = Boolean(file.oldPath);
  const hasNew = Boolean(file.newPath);
  if (!hasOld && !hasNew) return gaps;

  for (let i = 0; i < file.hunks.length; i += 1) {
    const hunk = file.hunks[i]!;

    if (i === 0 && hasNew) {
      const gapEnd = hunk.newStart - hunk.leadingContext - 1;
      const hiddenCount = gapEnd;
      if (hiddenCount > 0) {
        gaps.push({
          id: `${fileIndex}-before-${i}`,
          hiddenCount,
          gapStart: 1,
          gapEnd,
          oldGapStart: hasOld ? 1 : 0,
          oldGapEnd: hasOld ? hunk.oldStart - hunk.leadingContext - 1 : 0,
          hasOld,
          hasNew,
        });
      }
    }

    if (i > 0) {
      const prev = file.hunks[i - 1]!;
      if (hasNew) {
        const gapStart = prev.newEnd + 1;
        const gapEnd = hunk.newStart - hunk.leadingContext - 1;
        const hiddenCount = gapEnd - gapStart + 1;
        if (hiddenCount > 0) {
          gaps.push({
            id: `${fileIndex}-between-${i - 1}`,
            hiddenCount,
            gapStart,
            gapEnd,
            oldGapStart: hasOld ? prev.oldEnd + 1 : 0,
            oldGapEnd: hasOld ? hunk.oldStart - hunk.leadingContext - 1 : 0,
            hasOld,
            hasNew,
          });
        }
      }
    }
  }

  const last = file.hunks[file.hunks.length - 1];
  if (last && hasNew) {
    gaps.push({
      id: `${fileIndex}-after`,
      hiddenCount: -1,
      gapStart: last.newEnd + 1,
      gapEnd: -1,
      oldGapStart: hasOld ? last.oldEnd + 1 : 0,
      oldGapEnd: -1,
      hasOld,
      hasNew,
    });
  }

  return gaps;
}

export function isUnifiedDiff(text: string) {
  return /^(diff --git |--- |\+\+\+ |@@ )/m.test(text.trim());
}
