/**
 * The bytes of one side of a change, for the git panel's previews. A picture is
 * drawn from the very URL the browser is handed — `<img>`, `<video>` and the
 * PDF viewer stream it themselves instead of us holding a megabyte in memory —
 * and `gitBlobInfo` first asks what is there, so a side the version does not
 * have is a note rather than a broken picture.
 */

export type GitBlobInfo = { exists: boolean; size: number; mime: string | null };

/**
 * `sig` only busts the browser's cache of the working copy: the same path is
 * served with the same URL, and a file saved again must not show the old bytes.
 */
export function gitBlobUrl(
  sessionId: string,
  filePath: string,
  opts: { rev?: string | null; sig?: string } = {},
): string {
  const params = new URLSearchParams({ path: filePath });
  if (opts.rev) params.set("rev", opts.rev);
  if (opts.sig) params.set("sig", opts.sig);
  return `/api/sessions/${sessionId}/git/blob?${params.toString()}`;
}

/** What one side holds, without moving the bytes themselves. */
export async function gitBlobInfo(
  sessionId: string,
  filePath: string,
  rev?: string | null,
): Promise<GitBlobInfo> {
  const res = await fetch(`${gitBlobUrl(sessionId, filePath, { rev })}&info=1`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(res.statusText || "Could not read the file");
  return (await res.json()) as GitBlobInfo;
}
