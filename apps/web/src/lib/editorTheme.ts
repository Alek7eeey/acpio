import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

/**
 * The pane's chrome is painted from the app's own CSS variables, so a light app
 * gets a light editor and a hand-tuned colour scheme keeps both readable. Token
 * colours are the one thing a CSS variable cannot express per scheme, so each
 * scheme carries its own small palette.
 */
export type EditorScheme = "light" | "dark";

const PALETTES = {
  light: {
    keyword: "#8250df",
    string: "#0a7d3a",
    number: "#b35900",
    comment: "#6b7280",
    entity: "#0550ae",
    type: "#0f6d78",
    property: "#953800",
    text: "#0f1419",
    invalid: "#c1121f",
  },
  dark: {
    keyword: "#c9a7ff",
    string: "#7ee2a8",
    number: "#ffb87a",
    comment: "#7d8899",
    entity: "#79b8ff",
    type: "#7fd8e0",
    property: "#ffd085",
    text: "#e6edf3",
    invalid: "#ff7b72",
  },
} as const;

function highlightStyle(scheme: EditorScheme) {
  const c = PALETTES[scheme];
  return HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: c.keyword },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: c.string },
    { tag: [tags.number, tags.bool, tags.null], color: c.number },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: c.comment, fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: c.entity },
    { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: c.entity },
    { tag: [tags.typeName, tags.className, tags.namespace], color: c.type },
    { tag: [tags.propertyName, tags.attributeName], color: c.property },
    { tag: [tags.variableName, tags.name], color: c.text },
    { tag: [tags.tagName, tags.meta, tags.processingInstruction], color: c.keyword },
    { tag: tags.invalid, color: c.invalid, textDecoration: "underline wavy" },
  ]);
}

/** Editor chrome + token colours for one scheme. */
export function editorTheme(scheme: EditorScheme): Extension {
  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          fontSize: "13px",
          backgroundColor: "var(--surface)",
          color: "var(--text)",
        },
        ".cm-scroller": {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          lineHeight: "1.55",
        },
        ".cm-content": { caretColor: "var(--accent)" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
          backgroundColor: "var(--accent-soft)",
        },
        ".cm-gutters": {
          backgroundColor: "var(--surface-2)",
          color: "var(--text-secondary)",
          border: "none",
        },
        ".cm-activeLine": { backgroundColor: "var(--accent-soft)" },
        ".cm-activeLineGutter": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 8px" },
        ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)" },
        ".cm-tooltip": {
          backgroundColor: "var(--surface)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "8px",
        },
        ".cm-scroller::-webkit-scrollbar": { width: "10px", height: "10px" },
      },
      { dark: scheme === "dark" },
    ),
    EditorView.baseTheme({
      ".cm-lintRange-error": { textDecorationColor: "var(--danger)" },
      ".cm-lintRange-warning": { textDecorationColor: "var(--warning)" },
      ".cm-tooltip-lint": { borderColor: "var(--border)" },
    }),
    syntaxHighlighting(highlightStyle(scheme)),
  ];
}
