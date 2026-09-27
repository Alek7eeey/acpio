// String helpers shared by the CLI output formatting.

// Pad text out to width columns, then append the text.
export function padLeft(text, width, ch = " ") {
  let pad = "";
  while (pad.length < width) pad += ch;
  return pad + text;
}
