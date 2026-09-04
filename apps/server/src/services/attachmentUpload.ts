import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Folder under the session cwd where pasted/uploaded blobs land (agent-readable). */
export const ATTACH_DIR = ".acpio-attachments";

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
 * Write a clipboard/device image into the session cwd and return a path-based
 * attachment the existing prompt flow can consume.
 */
export async function stageSessionUpload(
  sessionId: string,
  cwd: string,
  input: { name: string; mime?: string; data: string },
): Promise<{ name: string; path: string; size: number }> {
  const buf = Buffer.from(input.data, "base64");
  if (!buf.length) throw new Error("Empty upload");
  if (buf.length > MAX_ATTACH_UPLOAD_BYTES) throw new Error("File too large");

  const mime = (input.mime ?? "").trim() || "application/octet-stream";
  const ext = extForMime(mime, input.name);
  let name = sanitizeFileName(input.name);
  if (!path.extname(name)) name = `${name}${ext}`;

  const dir = path.join(path.resolve(cwd), ATTACH_DIR, sessionId);
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
