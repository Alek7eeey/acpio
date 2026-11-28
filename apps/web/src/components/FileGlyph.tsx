/**
 * The document glyph of a file row, tinted by its extension — one shape for the
 * whole app, so a file looks the same in the code pane's tree and in the git
 * panel's changed files.
 */

/** Tint per extension, the way an editor's file icon set keys them. */
export const EXT_TINTS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#4ec9b0",
  js: "#e2c08d",
  jsx: "#4ec9b0",
  mjs: "#e2c08d",
  cjs: "#e2c08d",
  css: "#9d7bd8",
  scss: "#cf649a",
  json: "#cbcf4b",
  md: "#519aba",
  html: "#e37933",
  htm: "#e37933",
  cs: "#9b6bd6",
  svg: "#9d7bd8",
  yml: "#cbcf4b",
  yaml: "#cbcf4b",
  py: "#3572a5",
  go: "#00add8",
  rs: "#dea584",
  java: "#b07219",
  php: "#7a86b8",
  rb: "#cc342d",
  sql: "#d4c07a",
  sh: "#89e051",
  toml: "#9aa0a6",
  ini: "#9aa0a6",
  txt: "#9aa0a6",
  // Kinds the git panel draws itself: a picture, a player, a viewer.
  png: "#a074c4",
  jpg: "#a074c4",
  jpeg: "#a074c4",
  gif: "#a074c4",
  webp: "#a074c4",
  bmp: "#a074c4",
  ico: "#a074c4",
  avif: "#a074c4",
  mp4: "#e0575b",
  webm: "#e0575b",
  mov: "#e0575b",
  mp3: "#e2a03f",
  wav: "#e2a03f",
  pdf: "#e05252",
  doc: "#2b579a",
  docx: "#2b579a",
  xls: "#217346",
  xlsx: "#217346",
  ppt: "#d24726",
  pptx: "#d24726",
  zip: "#8a8a8a",
  gz: "#8a8a8a",
  tar: "#8a8a8a",
  lock: "#9aa0a6",
};

export function FileGlyph({
  name,
  className,
  width = 16,
  height = 16,
}: {
  /** The file's name or path: only the extension picks the tint. */
  name: string;
  className?: string;
  width?: number;
  height?: number;
}) {
  const tint = EXT_TINTS[name.split(".").pop()?.toLowerCase() ?? ""] ?? "var(--text-secondary)";
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M4 1.5h4.6L12.5 5.4V14.5H4z M8.6 1.5v3.9h3.9"
        fill="none"
        stroke={tint}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
