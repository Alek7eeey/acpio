import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { DATA_DIR } from "../db/client.js";

/** Folder under the session cwd where pasted/uploaded blobs land (agent-readable). */
export const ATTACH_DIR = ".acpio-attachments";

/**
 * Acpio's own attachment root, beside the DB. Files attached to a board task
 * live here: the task is worked in the user's project folder, and an
 * attachment that belongs to the card must not appear in their repository.
 */
export const ACPIO_ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");

/**
 * Ceiling on one upload. An attachment is handed to the agent as a path, never
 * inlined, so the size is nobody's business but the disk's — the limit is a
 * backstop against a runaway body, not a judgement about the file. Measured
 * at 15 MB, where a 16 MB log was refused in the chat (and, silently, on the
 * board: the server answered 413 and the card only kept the file's name).
 */
export const MAX_ATTACH_UPLOAD_BYTES = 1024 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
};

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]/g, "_").trim();
  return (base || "file").slice(0, 120);
}

function extForMime(mime: string, fallbackName: string): string {
  const fromMime = MIME_EXT[mime.toLowerCase()];
  if (fromMime) return fromMime;
  const fromName = path.extname(fallbackName);
  return fromName || ".bin";
}

/** Claim a free name in `dir` and hold its file open, so a paste that lands on
 *  the same name in the same second gets `-2`, `-3`, … and nothing is
 *  overwritten. */
async function claimName(
  dir: string,
  name: string,
): Promise<{ fileId: string; handle: FileHandle }> {
  const stem = path.basename(name, path.extname(name));
  const suffix = path.extname(name);
  let fileId = name;
  for (let n = 2; ; n += 1) {
    try {
      return { fileId, handle: await open(path.join(dir, fileId), "wx") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST" || n > 50) throw err;
      fileId = `${stem}-${n}${suffix}`;
    }
  }
}

/**
 * Name the upload and drop it under `<root>/<sessionId>`, straight from the
 * request body.
 *
 * The body is piped to disk instead of being buffered: a reader attaching a
 * 300 MB log must cost the server a chunk of memory, not the whole file (the
 * route used to buffer up to its body limit, which is what capped attachments
 * at 15 MB). The name is claimed with `wx` before the first byte is read, so a
 * taken name is skipped while nothing has been consumed off the request.
 */
async function stageUpload(
  root: string,
  sessionId: string,
  input: { name: string; mime?: string; stream: Readable; limit?: number },
): Promise<{ name: string; path: string; size: number }> {
  const limit = input.limit ?? MAX_ATTACH_UPLOAD_BYTES;
  const mime = (input.mime ?? "").trim() || "application/octet-stream";
  const ext = extForMime(mime, input.name);
  let name = sanitizeFileName(input.name);
  if (!path.extname(name)) name = `${name}${ext}`;

  const dir = path.join(path.resolve(root), sessionId);
  await mkdir(dir, { recursive: true });

  // Avoid clobbering an earlier paste in the same second.
  const { fileId, handle } = await claimName(dir, name);

  const dest = path.join(dir, fileId);
  const out = handle.createWriteStream();
  let size = 0;
  try {
    for await (const chunk of input.stream) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > limit) {
        // Nothing of this file may stay behind: the reader is told it did not
        // land, and a half-written blob is a file they never asked for.
        input.stream.resume();
        throw new Error("File too large");
      }
      if (!out.write(buf)) await once(out, "drain");
    }
    if (size === 0) throw new Error("Empty upload");
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return { name: fileId, path: dest, size };
  } catch (err) {
    out.destroy();
    await unlink(dest).catch(() => {});
    throw err;
  }
}

/**
 * Write a pasted/uploaded file into the session cwd and return a path-based
 * attachment the existing prompt flow can consume. Regular chats keep their
 * files next to the code the agent reads.
 */
export async function stageSessionUpload(
  sessionId: string,
  cwd: string,
  input: { name: string; mime?: string; stream: Readable; limit?: number },
): Promise<{ name: string; path: string; size: number }> {
  return stageUpload(path.join(path.resolve(cwd), ATTACH_DIR), sessionId, input);
}

/**
 * Write a pasted/uploaded file into acpio's own data folder instead of the
 * session cwd — the scope board tasks use, so their files never land in the
 * project the task is worked in. The attachment is still a plain absolute
 * path, which the prompt flow reads in place like any other server file.
 */
export async function stageAcpioUpload(
  sessionId: string,
  input: { name: string; mime?: string; stream: Readable; limit?: number },
): Promise<{ name: string; path: string; size: number }> {
  return stageUpload(ACPIO_ATTACHMENTS_DIR, sessionId, input);
}

/**
 * Folders this session's own uploads land in: the chat folder's attachment dir
 * and acpio's data dir (a board task's files). Nothing else is ever written by
 * `stageUpload`, so nothing else may be deleted on a chip's removal — the path
 * comes from the client, and a project source file the reader attached from
 * the server must survive its chip going away.
 */
function stagingDirs(sessionId: string, cwd: string): string[] {
  const roots = [path.join(path.resolve(cwd), ATTACH_DIR), ACPIO_ATTACHMENTS_DIR];
  return roots.map((root) => path.resolve(root, sessionId) + path.sep);
}

/**
 * Delete the file behind a composer chip the reader removed before sending.
 * The chip was the only reference to those bytes, so a staged file that stays
 * on disk piles up in the folder unseen.
 *
 * Answers whether a file was actually unlinked: a path outside this session's
 * staging folders (or one already gone) is not an error worth reporting.
 */
export async function discardStagedUpload(
  sessionId: string,
  cwd: string,
  filePath: string,
): Promise<boolean> {
  if (!sessionId || !filePath || !path.isAbsolute(filePath)) return false;
  const target = path.resolve(filePath);
  const key = target.toLowerCase();
  const inside = stagingDirs(sessionId, cwd).some((dir) => key.startsWith(dir.toLowerCase()));
  if (!inside) return false;
  try {
    await unlink(target);
    return true;
  } catch {
    return false;
  }
}
