/**
 * Where a click on a file sends it. Settings carry the reader's choice — the
 * file itself (downloaded, opened by the OS, or shown in Explorer, as it always
 * was) or the same file in the code pane beside the chat.
 *
 * The four places a file is clicked — an attachment under a message, a link in
 * an answer, a path in a tool's output and the git panel's «Открыть файл» — all
 * ask here, so the choice means the same thing in each of them. `false` means
 * "not here, do what you did before": a binary file has nothing to show in a
 * text editor, and a file outside every folder the pane knows is not reachable.
 */
import { canonicalCwd } from "@acpio/shared";
import { isImageFile } from "./pathSegments";
import { selectLiveSessionDetail, useAppStore } from "./store";

/**
 * Extensions the code pane can only show as garbage: it reads every file as
 * UTF-8, so opening one of these and saving it would overwrite the bytes with
 * replacement characters.
 */
const BINARY_EXT = new Set([
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "7z",
  "rar",
  "tar",
  "exe",
  "msi",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "db",
  "sqlite",
  "sqlite3",
  "class",
  "jar",
  "pyc",
  "node",
  "wasm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
  "xls",
  "xlsx",
  "doc",
  "docx",
  "ppt",
  "pptx",
]);

/** Whether this build is set to open clicked files in the code pane. */
export function fileOpensInEditor(): boolean {
  return useAppStore.getState().settings.fileOpenTarget === "editor";
}

/** `/a/b/c` → `["a", "b", "c"]` — a drive letter stays a segment, like `C:`. */
function segments(path: string): string[] {
  return canonicalCwd(path).split(/[\\/]+/).filter(Boolean);
}

/**
 * `abs` as a path inside `root`, or null when it is not under it. Segments are
 * compared case-insensitively (a Windows path may be spelled either way) but the
 * result keeps the file's own spelling, which is what the server is asked for.
 */
export function editorRelPath(root: string, abs: string): string | null {
  const base = segments(root);
  const full = segments(abs);
  if (base.length === 0 || full.length <= base.length) return null;
  for (let i = 0; i < base.length; i += 1) {
    if (base[i]!.toLowerCase() !== full[i]!.toLowerCase()) return null;
  }
  return full.slice(base.length).join("/");
}

/** A file the code pane can actually show as text. */
export function canOpenInEditor(abs: string): boolean {
  const name = segments(abs).pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return !isImageFile(name) && !BINARY_EXT.has(ext);
}

/**
 * The pane folder a path belongs to, in the order that keeps the reader's own
 * chat first: its own folder, the folder on screen, a pane already open, and
 * finally a folder the tree knows about.
 */
export function editorRootFor(
  abs: string,
  runtimes: { sessionCwd?: string | null; activeCwd?: string | null; panes?: string[]; folders?: string[] } = {},
): string | null {
  const candidates = [
    runtimes.sessionCwd,
    runtimes.activeCwd,
    ...(runtimes.panes ?? []),
    ...(runtimes.folders ?? []),
  ];
  for (const root of candidates) {
    if (root && editorRelPath(root, abs) !== null) return canonicalCwd(root);
  }
  return null;
}

/** Is this path on the machine at all — a drive letter or a leading slash? */
export function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path.trim());
}

/** A relative path as a file inside the chat's folder, the way the server reads it. */
export function absoluteFor(root: string, rel: string): string {
  const base = canonicalCwd(root).replace(/\/+$/, "");
  return `${base}/${rel.replace(/^[\\/]+/, "")}`;
}

/**
 * Show `abs` in the code pane, if the reader asked for that and the pane can take
 * it. Answers whether it did — a caller that gets `false` carries on with what it
 * always did, so a click is never swallowed without opening anything.
 */
export function openFileInEditor(input: {
  path: string;
  /** The chat the click came from: its folder wins over the one on screen. */
  sessionId?: string | null;
  line?: number;
  col?: number;
}): boolean {
  if (!fileOpensInEditor()) return false;
  const abs = input.path.trim();
  if (!abs || !isAbsolutePath(abs) || !canOpenInEditor(abs)) return false;

  const state = useAppStore.getState();
  const sessionCwd = input.sessionId
    ? selectLiveSessionDetail(state, input.sessionId)?.cwd
    : null;
  const root = editorRootFor(abs, {
    sessionCwd,
    activeCwd: state.activeSession?.cwd ?? null,
    panes: state.openEditors.map((pane) => pane.root),
    folders: state.knownFolders ?? [],
  });
  if (!root) return false;
  const rel = editorRelPath(root, abs);
  if (!rel) return false;

  state.revealInEditor({ root, rel, line: input.line, col: input.col });
  // The pane is the point of the setting: a file opened into a hidden pane is a
  // click that did nothing. The fab beside the chat turns it off again.
  if (state.settings.editorSplit === "off") void state.saveSettings({ editorSplit: "left" });
  return true;
}
