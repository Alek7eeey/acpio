// The repository's own instructions for agents, matched from the chat's cwd on
// every turn against Settings → Built-in agent `builtinProjectRules` (by
// default `AGENTS.md`, the legacy `.cursorrules` and the Cursor-compatible
// `.cursor/rules/**/*.mdc`). A rule that applies whatever the task is goes into
// the system prompt inline; one gated on `globs` (or merely on a `description`)
// is listed by path instead, so the model reads it when the files it touches
// match — the split Cursor itself makes, without a per-file matcher here. Read
// per turn rather than frozen like the skills block: an edited rule is meant to
// bite the next turn, and the prompt bytes change only when the file does.
import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BUILTIN_PROJECT_RULES, normalizeBuiltinProjectRules } from "@acpio/shared";
import type { ModelMessage } from "ai";
import { minimatch } from "minimatch";

export interface ProjectRule {
  /** Path the model opens it by: relative to the working directory, `/`-joined. */
  path: string;
  /** Frontmatter `description`, else "". */
  description: string;
  /** Frontmatter `globs`, comma-joined — the files this rule is about. */
  globs: string;
  /** Belongs in the prompt whatever the task is. */
  always: boolean;
  body: string;
}

/** Tools whose call names one file — the paths a rule's `globs` are about. */
const PATH_TOOLS = new Set(["read", "edit", "write"]);

/** Directories a user pattern never has to walk: a package dump has no rules. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_RULES = 50;
const PER_RULE_CHAR_LIMIT = 8_000;
const INLINE_CHAR_LIMIT = 12_000;

/**
 * One rule file. Cursor's `.mdc` frontmatter carries `description`, `globs` and
 * `alwaysApply`; `globs` may be a comma list or a YAML block list. A file with
 * no frontmatter at all — `AGENTS.md`, `.cursorrules` — always applies, and so
 * does a `.mdc` that gates on nothing.
 */
export function parseRuleFile(text: string, relPath: string): ProjectRule {
  const rule: ProjectRule = {
    path: relPath,
    description: "",
    globs: "",
    always: true,
    body: text.trim(),
  };
  if (!text.startsWith("---")) return rule;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return rule;
  const values: Record<string, string> = {};
  let key = "";
  for (const line of text.slice(3, end).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") && key) {
      values[key] = values[key] ? `${values[key]}, ${trimmed.slice(2).trim()}` : trimmed.slice(2).trim();
      continue;
    }
    const at = line.indexOf(":");
    if (at === -1) continue;
    key = line.slice(0, at).trim().toLowerCase();
    values[key] = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  rule.body = text.slice(end + 4).trim();
  rule.description = values.description ?? "";
  rule.globs = values.globs ?? "";
  // `alwaysApply` decides when it is there; a rule that gates on nothing is
  // still meant to be followed, so it is not silently dropped.
  rule.always =
    values.alwaysapply === undefined ? !rule.globs && !rule.description : /^(true|yes|1|on)$/i.test(values.alwaysapply);
  return rule;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * The rule files the configured patterns match in `cwd`, parsed. Patterns are
 * matched in the order they are configured, so the first one is what the inline
 * budget serves first; a path two patterns both match is read once. A malformed
 * pattern is skipped instead of failing the turn that only wanted the prompt.
 */
export async function discoverProjectRules(
  cwd: string,
  patterns: unknown = DEFAULT_BUILTIN_PROJECT_RULES,
): Promise<ProjectRule[]> {
  if (!cwd) return [];
  const files: Array<{ rel: string; text: string }> = [];
  const seen = new Set<string>();
  for (const pattern of normalizeBuiltinProjectRules(patterns)) {
    try {
      for await (const match of fsp.glob(pattern, {
        cwd,
        exclude: (file) => file.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg)),
      })) {
        const rel = match.split(path.sep).join("/").replace(/^\.\//, "");
        if (seen.has(rel)) continue;
        seen.add(rel);
        const text = await readText(path.join(cwd, ...rel.split("/")));
        if (text !== null) files.push({ rel, text });
        if (files.length >= MAX_RULES) return files.map((file) => parseRuleFile(file.text, file.rel));
      }
    } catch {
      // A pattern the platform rejects contributes nothing.
    }
  }
  return files.map((file) => parseRuleFile(file.text, file.rel));
}

/**
 * Files the conversation has already opened or changed, relative to `cwd`: the
 * `path` of every `read`/`edit`/`write` call in the stored history. What a rule
 * gates on with `globs` is answered by this list — the model touched the file,
 * so the rule about that file belongs in the prompt now, not in a list it may
 * never come back to.
 */
export function touchedFiles(messages: readonly ModelMessage[], cwd: string): string[] {
  const out = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || !PATH_TOOLS.has(part.toolName)) continue;
      const raw = (part.input as { path?: unknown } | undefined)?.path;
      if (typeof raw !== "string" || !raw.trim()) continue;
      const full = raw.trim().replace(/\\/g, "/");
      const rel = path.isAbsolute(full)
        ? path.relative(cwd, full).split(path.sep).join("/")
        : full.replace(/^\.\//, "");
      // A file outside the chat's folder says nothing about a glob written from
      // its root, and `..` segments would only make the match lie.
      if (!rel || rel === ".." || rel.startsWith("../") || rel.split("/").includes("..")) continue;
      out.add(rel);
    }
  }
  return [...out];
}

/** Does one of a rule's comma-separated `globs` name one of the touched files? */
function globMatches(globs: string, touched: readonly string[]): boolean {
  if (!touched.length) return false;
  const patterns = globs
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean);
  return patterns.some((glob) => touched.some((file) => minimatch(file, glob, { dot: true })));
}

/**
 * The prompt block, or "" when the repository ships no rules. Inline rules keep
 * their text in full (up to a per-rule and an overall cap); anything over the
 * cap joins the conditional ones, where a path and a line still earn the read —
 * and a conditional rule whose `globs` match a file the conversation already
 * touched stops being conditional and is inlined like an always-on one.
 */
export async function renderProjectRules(
  cwd: string,
  patterns?: unknown,
  touched: readonly string[] = [],
): Promise<string> {
  const rules = await discoverProjectRules(cwd, patterns);
  if (!rules.length) return "";
  const inlined = rules.filter((rule) => rule.always || (rule.globs && globMatches(rule.globs, touched)));
  const listed = rules.filter((rule) => !inlined.includes(rule));
  const inline: string[] = [];
  let budget = INLINE_CHAR_LIMIT;
  for (const rule of inlined) {
    const body =
      rule.body.length > PER_RULE_CHAR_LIMIT
        ? `${rule.body.slice(0, PER_RULE_CHAR_LIMIT)}\n...[truncated]...`
        : rule.body;
    if (!body) continue;
    if (body.length > budget) {
      listed.push(rule);
      continue;
    }
    budget -= body.length;
    inline.push(`--- ${rule.path} ---\n${body}`);
  }
  if (!inline.length && !listed.length) return "";
  return [
    "",
    // More specific than the laws above, like a skill (see `renderSkillsSection`):
    // the repository's own rules are what this project means by "smallest change".
    "Project rules — this repository's own instructions for agents. They are more specific than the rules above: where they disagree, these win.",
    ...inline,
    ...(listed.length
      ? [
          "",
          "Conditional project rules (each is about some files only: read it with `read` when the files you touch match its globs):",
          ...listed.map(
            (rule) =>
              `- \`${rule.path}\`${rule.description ? ` — ${rule.description}` : ""}${rule.globs ? ` (globs: ${rule.globs})` : ""}`,
          ),
        ]
      : []),
  ].join("\n");
}
