import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { IMAGE_MIME } from "./imageTypes.js";
import { ATTACH_DIR } from "./attachmentUpload.js";

/** Folder under a chat's attachment dir where the pictures of one message live. */
export const SNAPSHOT_DIR = "snapshots";

/**
 * Ceiling on one kept picture. The bytes are copied into the chat's own folder,
 * so a file that is not really a screenshot must not be dragged along by a
 * mention — a picture above this size keeps its path and its caption.
 */
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** A markdown image, the shape the reader parses: `![alt](dest)`. */
const IMAGE_REF = /!\[([^\]\n]*)\]\(([^)\n]*)\)/g;

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The path an image's destination names — `file:///C:/x.png`, a Windows drive,
 * or one relative to the chat folder. The web client resolves a destination the
 * same way; a scheme that is not a file (`data:`, `https:`) is not a path and
 * is left to the browser.
 */
function localPathOf(dest: string): string | null {
  const trimmed = dest.trim();
  const url =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  if (!url) return null;
  const fileUrl = /^file:\/\/(.*)$/i.exec(url);
  if (fileUrl) {
    const rest = decodePath(fileUrl[1] ?? "");
    // `file:///C:/x.png` — the slash before a drive letter is not a path part.
    return /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest;
  }
  if (/^[A-Za-z]:[\\/]/.test(url)) return decodePath(url);
  return /^[a-z][a-z0-9+.-]+:/i.test(url) ? null : decodePath(url);
}

/** A file name for the copy: the original's, stripped of what a path rejects. */
function snapshotName(index: number, sourcePath: string): string {
  const ext = path.extname(sourcePath).slice(1).toLowerCase();
  const stem = path
    .basename(sourcePath, path.extname(sourcePath))
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${index}-${stem || "picture"}.${ext}`;
}

/**
 * Keep the pictures an answer shows, so a message reads the same later.
 *
 * A markdown image is a path, and a path is not a version: the agent saves
 * `shot.png` again, or deletes it, and every message that ever pointed at it
 * changes with the file — the reader loses what the answer actually showed, and
 * the same bytes reappear under a message that never produced them. Copying the
 * picture once, into `<cwd>/.acpio-attachments/<session>/snapshots/<message>/`,
 * and pointing the text at the copy makes the message own its picture: the
 * original can be overwritten or deleted and the answer stays what it was.
 *
 * Runs when the answer is final (see `snapshotTurnImages`), so the bytes copied
 * are the ones the agent had just saved. A destination already pointing into
 * the snapshot tree, a scheme the browser fetches itself, a file that is gone,
 * not an image, or too large — all keep their text untouched.
 */
export async function snapshotMessageImages(input: {
  sessionId: string;
  cwd: string;
  messageId: string;
  text: string;
}): Promise<string> {
  const refs = [...input.text.matchAll(IMAGE_REF)];
  if (refs.length === 0) return input.text;

  const cwd = path.resolve(input.cwd);
  const keptRoot = path.join(cwd, ATTACH_DIR, input.sessionId, SNAPSHOT_DIR);
  const dir = path.join(keptRoot, input.messageId);
  let out = input.text;

  // Back to front: a rewrite must not shift the offsets of the matches before it.
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!;
    const local = localPathOf(ref[2] ?? "");
    if (!local) continue;
    const source = path.isAbsolute(local) ? path.resolve(local) : path.resolve(cwd, local);
    // Already a copy — the second pass over the same answer changes nothing.
    if (source.startsWith(keptRoot + path.sep)) continue;
    const ext = path.extname(source).slice(1).toLowerCase();
    if (!IMAGE_MIME[ext]) continue;

    const name = snapshotName(i + 1, source);
    const kept = path.join(dir, name);
    try {
      const info = await stat(source);
      if (!info.isFile() || info.size === 0 || info.size > MAX_SNAPSHOT_BYTES) continue;
      await mkdir(dir, { recursive: true });
      await writeFile(kept, await readFile(source), { flag: "wx" });
    } catch (err) {
      // A copy that already exists is this message's own earlier pass; every
      // other failure (gone, unreadable, full disk) leaves the text alone.
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") continue;
    }
    const rel = path.relative(cwd, kept).split(path.sep).join("/");
    const at = ref.index ?? 0;
    out = `${out.slice(0, at)}![${ref[1] ?? ""}](${rel})${out.slice(at + ref[0].length)}`;
  }
  return out;
}
