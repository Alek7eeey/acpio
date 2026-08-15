/** Path helpers shared by the server-browse dialogs (attach + folder picker). */

export const DRIVES_ROOT = "Computer";

/** Extensions rendered as inline image previews (see IMAGE_MIME on the server). */
export const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

export function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT.has(ext);
}

export function isWindowsPath(path: string) {
  return path === DRIVES_ROOT || /^[a-zA-Z]:/.test(path) || path.includes("\\");
}

/** Split a path into clickable breadcrumb segments (label + navigable path). */
export function splitPathSegments(
  fullPath: string,
  drivesLabel: string,
): Array<{ label: string; path: string }> {
  if (fullPath === DRIVES_ROOT) {
    return [{ label: drivesLabel, path: DRIVES_ROOT }];
  }

  const trimmed = fullPath.trim();
  if (!trimmed) return [];

  // Filesystem root on Unix
  if (trimmed === "/" || trimmed === "\\") {
    return [{ label: "/", path: "/" }];
  }

  const winDrive = trimmed.match(/^([a-zA-Z]:)([\\/]|$)/);
  const isUnixAbsolute = trimmed.startsWith("/");
  const sep = trimmed.includes("\\") && !isUnixAbsolute ? "\\" : "/";
  const rawParts = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  const parts: string[] = [];

  if (winDrive) {
    parts.push(winDrive[1]);
    parts.push(...rawParts.slice(1));
  } else {
    parts.push(...rawParts);
  }

  const segments: Array<{ label: string; path: string }> = [];
  if (winDrive) {
    segments.push({ label: drivesLabel, path: DRIVES_ROOT });
  } else if (isUnixAbsolute) {
    segments.push({ label: "/", path: "/" });
  }

  for (let i = 0; i < parts.length; i++) {
    if (winDrive && i === 0) {
      segments.push({ label: parts[i], path: `${parts[i]}\\` });
      continue;
    }
    const slice = winDrive ? [winDrive[1], ...parts.slice(1, i + 1)] : parts.slice(0, i + 1);
    const path = winDrive
      ? `${slice[0]}\\${slice.slice(1).join("\\")}`
      : isUnixAbsolute
        ? `/${slice.join("/")}`.replace(/\/+/g, "/")
        : slice.join(sep);
    segments.push({ label: parts[i], path });
  }
  return segments;
}
