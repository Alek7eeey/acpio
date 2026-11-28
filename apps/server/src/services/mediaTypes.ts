/**
 * Content types the git panel shows as themselves: a picture as a picture, a
 * video as a player, a PDF in the browser's own viewer. Office documents are in
 * no browser's renderer, so they stay out of this table and download instead —
 * a `.docx` served as `application/octet-stream` is the honest answer, while a
 * wrong type would make the browser guess and show nothing.
 */
import path from "node:path";

import { IMAGE_MIME } from "./imageTypes.js";

const MEDIA_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  pdf: "application/pdf",
};

const PREVIEW_MIME: Record<string, string> = { ...IMAGE_MIME, ...MEDIA_MIME };

/** The content type of a previewable file, or null when it only downloads. */
export function previewMime(filePath: string): string | null {
  return PREVIEW_MIME[path.extname(filePath).slice(1).toLowerCase()] ?? null;
}
