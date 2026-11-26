/**
 * Language support for a document of the code pane. Lives outside the page
 * because the diff the git panel embeds is the same editor, and a diff of a
 * TypeScript file has to read like one in both places.
 */
import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { sass } from "@codemirror/legacy-modes/mode/sass";

/**
 * Languages that are loaded on demand: a pane that opens no YAML should not ship
 * a YAML parser. A document is created without them and gets the extension in
 * its state before the tab appears (`primeLanguage` fills the cache first).
 */
const lazyLanguage: Record<string, () => Promise<Extension>> = {
  json: async () => (await import("@codemirror/lang-json")).json(),
  jsonc: async () => (await import("@codemirror/lang-json")).json(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  htm: async () => (await import("@codemirror/lang-html")).html(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
};

/** Extension loaded so far, keyed by file path. */
const languageCache = new Map<string, Extension>();

/** Load a lazy language before its document is built. */
export async function primeLanguage(path: string) {
  if (languageCache.has(path)) return;
  const ext = lazyLanguage[extensionOf(path)];
  if (ext === undefined) return;
  try {
    languageCache.set(path, await ext());
  } catch {
    // A chunk that will not load costs highlighting, not the file.
    languageCache.set(path, []);
  }
}

export function extensionOf(path: string) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export function languageFor(path: string) {
  const ext = extensionOf(path);
  const cached = languageCache.get(path);
  if (cached) return cached;
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    return javascript({ typescript: ext.startsWith("ts"), jsx: ext === "tsx" || ext === "jsx" });
  }
  // SCSS has no CM6 parser of its own; the CM5 mode beats plain text.
  if (ext === "scss" || ext === "sass") return StreamLanguage.define(sass);
  if (ext === "cs") return StreamLanguage.define(csharp);
  return [];
}
