/**
 * Content types for inline image previews of files the server reads off disk —
 * an attachment behind `?inline=1`, a picture an answer points at, a snapshot a
 * message keeps. One table, because a file that can be served inline and a file
 * worth keeping for a message must be the same set: anything else downloads.
 */
export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};
