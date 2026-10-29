/**
 * The names a composer paints as links.
 *
 * An attached file is named in the text by its own name — the path it landed at
 * belongs to the app and is written when the message goes out — and a textarea
 * cannot colour a range of its text. So the composer draws the same text under
 * the field (see `ComposerMirror` in the chat page and the board's own copy),
 * and this is the split both of them paint: the text cut into runs, the ones
 * that are a file's name marked.
 */
export type LinkNameRun = { text: string; link: boolean };

export function splitLinkNames(text: string, names: string[]): LinkNameRun[] {
  const known = names.filter((name) => name && text.includes(name));
  if (known.length === 0) return text ? [{ text, link: false }] : [];
  // Longest name first: one that begins another must still win.
  const pattern = new RegExp(
    `(${[...known]
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})`,
    "g",
  );
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, link: known.includes(part) }));
}
