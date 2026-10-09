import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../db/client.js";

/** Folder under the session cwd where pasted/uploaded blobs land (agent-readable). */
export const ATTACH_DIR = ".acpio-attachments";

/**
 * Acpio's own attachment root, beside the DB. Pictures attached to a board
 * task live here: the task is worked in the user's project folder, and a
 * screenshot that belongs to the card must not appear in their repository.
 */
export const ACPIO_ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");

export const MAX_ATTACH_UPLOAD_BYTES = 15 * 1024 * 1024;

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

/**
 * Validate the blob, name it and drop it under `<root>/<sessionId>`.
 *
 * Takes the raw bytes: the client posts the clipboard blob as-is, so neither
 * side pays the base64 round-trip (a 15 MB screenshot becomes ~20 MB of JSON).
 */
async function stageUpload(
  root: string,
  sessionId: string,
  input: { name: string; mime?: string; bytes: Buffer },
): Promise<{ name: string; path: string; size: number }> {
  const buf = input.bytes;
  if (!buf.length) throw new Error("Empty upload");
  if (buf.length > MAX_ATTACH_UPLOAD_BYTES) throw new Error("File too large");

  const mime = (input.mime ?? "").trim() || "application/octet-stream";
  const ext = extForMime(mime, input.name);
  let name = sanitizeFileName(input.name);
  if (!path.extname(name)) name = `${name}${ext}`;

  const dir = path.join(path.resolve(root), sessionId);
  await mkdir(dir, { recursive: true });

  const stem = path.basename(name, path.extname(name));
  const suffix = path.extname(name);
  let fileId = name;
  let n = 2;
  // Avoid clobbering an earlier paste in the same second.
  while (true) {
    try {
      const dest = path.join(dir, fileId);
      await writeFile(dest, buf, { flag: "wx" });
      return { name: fileId, path: dest, size: buf.length };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      fileId = `${stem}-${n}${suffix}`;
      n += 1;
      if (n > 50) throw err;
    }
  }
}

/**
 * Write a pasted/uploaded image into the session cwd and return a path-based
 * attachment the existing prompt flow can consume. Regular chats keep their
 * pictures next to the code the agent reads.
 */
export async function stageSessionUpload(
  sessionId: string,
  cwd: string,
  input: { name: string; mime?: string; bytes: Buffer },
): Promise<{ name: string; path: string; size: number }> {
  return stageUpload(path.join(path.resolve(cwd), ATTACH_DIR), sessionId, input);
}

/**
 * Write a pasted/uploaded image into acpio's own data folder instead of the
 * session cwd — the scope board tasks use, so their pictures never land in
 * the project the task is worked in. The attachment is still a plain absolute
 * path, which the prompt flow reads in place like any other server file.
 */
export async function stageAcpioUpload(
  sessionId: string,
  input: { name: string; mime?: string; bytes: Buffer },
): Promise<{ name: string; path: string; size: number }> {
  return stageUpload(ACPIO_ATTACHMENTS_DIR, sessionId, input);
}
