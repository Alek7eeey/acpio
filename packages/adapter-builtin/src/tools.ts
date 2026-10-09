import { existsSync } from "node:fs";
import type { AgentMode, ElicitationRequestedSchema } from "@acpio/shared";
import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { HostClient } from "./host.js";
import { makeTaskTool, type SubagentsBridge } from "./subagents.js";

/** Ask the harness permission dialog; throws when the user declines. */
export type AskPermission = (toolCall: {
  title: string;
  /** ACP `ToolKind`: "execute" for shells, "edit" for file writes. */
  kind: string;
  input: Record<string, unknown>;
}) => Promise<void>;

export interface BuiltinToolOptions {
  host: HostClient;
  mode: AgentMode;
  ask: AskPermission;
  /**
   * Present only when the subagents feature is on: adds the `task` tool. The
   * child toolset is built without it, so subagents cannot nest.
   */
  subagents?: SubagentsBridge;
  /**
   * Session these calls belong to. The question card is an ACP
   * `elicitation/create`, and the harness binds that request to the session
   * that asked — a card from a session it does not know is cancelled.
   */
  sessionId: string;
  /**
   * The harness lets paths outside the session cwd through (Settings →
   * Built-in agent). Only the `write` blurb changes with it: the agent must not
   * claim a boundary the harness no longer draws.
   */
  outsideCwd?: boolean;
}

/** Terminal output the model gets: enough to act on, bounded for the context. */
const CLIP_HEAD = 4_000;
const CLIP_TAIL = 2_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 300_000;
const TERMINAL_BYTE_LIMIT = 64 * 1024;
const MAX_SEARCH_RESULTS = 200;
const MAX_GLOB_RESULTS = 500;
/**
 * Read contract, pi's numbers: whichever cap is hit first ends the window.
 * Line endings are normalized to `\n`: repos check out CRLF on Windows, and a
 * model copying `old_string` from a `\r\n` read hands `edit` a needle that
 * matches nothing — four failed edits on one task is what that costs.
 */
const READ_MAX_LINES = 2_000;
const READ_MAX_CHARS = 50_000;
/**
 * What a `read` with no window of its own gets. A bare call means "show me the
 * file", not "hand me all of it": a model that knows what it needs says so
 * with `line`/`limit`, and that request is honoured up to the caps above.
 */
const READ_DEFAULT_LINES = 400;
const READ_DEFAULT_CHARS = 12_000;

/**
 * Bound what a single `read` hands the model and say how to continue. Without
 * this a big file lands whole in the context, and the model has no idea it
 * could page - pi's read discloses exactly this window and the way to walk it.
 * Slicing is byte-faithful (no line-ending normalization).
 */
export function windowRead(
  content: string,
  path: string,
  fromLine: number,
  maxLines: number = READ_MAX_LINES,
  maxChars: number = READ_MAX_CHARS,
  /** Lines the *file* has, when the host already sliced it for us. */
  fileLines?: number,
): string {
  const gotLines = content.split("\n").length;
  let end = content.length;
  let linesShown = gotLines;
  if (gotLines > maxLines) {
    let idx = -1;
    for (let i = 0; i < maxLines; i++) {
      idx = content.indexOf("\n", idx + 1);
      if (idx < 0) break;
    }
    end = idx < 0 ? content.length : idx + 1;
    linesShown = maxLines;
  }
  if (end > maxChars) {
    end = maxChars;
    linesShown = content.slice(0, end).split("\n").length;
  }
  if (end >= content.length) return content;
  const nextLine = fromLine + linesShown;
  return (
    `${content.slice(0, end)}\n...[truncated at ${linesShown} lines / ${maxChars} chars: ` +
    `${path} has ${fileLines ?? gotLines} lines; continue with read({ path, line: ${nextLine} })]...`
  );
}

/** Width of the size column so a listing stays scannable. */
const SIZE_COLUMN = 8;

/**
 * Size as the model judges it ("worth opening?"), not as digits: `34 KB` beats
 * `34681`, and `?` is the honest answer for a file the stat could not reach.
 */
function sizeLabel(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// ── a character window: the way on inside one long line ──────────────────────
//
// A file that is a single long line (a bundle, a minified JSON, base64) has no
// `line: 2` to continue from, and `read` alone cannot reach past the first
// window. `char_offset`/`char_limit` are that way on, and they live in the tool
// schema rather than in a hint: measured on the real agent, a model that knows
// the file is one long line plans the window *before* it calls anything, so a
// footer (which it only ever sees after the wall) is read too late to matter.
/** Chars one window returns: the shell's own output cap, and ~1.5k tokens. */
const CHAR_WINDOW_CHARS = CLIP_HEAD + CLIP_TAIL;

interface CharWindow {
  path: string;
  /** 1-based first character, the way `read` numbers lines. */
  from: number;
  len: number;
}

/** The window, how much of the file it is, and the call that continues it. */
function charWindow(content: string, req: CharWindow): string {
  const chars = content.length;
  const from = Math.min(req.from, chars + 1);
  const to = Math.min(chars, from - 1 + req.len);
  const next =
    to < chars ? `\n...continue with char_offset: ${to + 1} (char_limit: ${CHAR_WINDOW_CHARS})` : "";
  return `[chars ${from}-${to} of ${chars} in ${req.path}]\n${content.slice(from - 1, to)}${next}`;
}

/** What the scan did not look into — silence here reads as "there is nothing". */
function notSearched(
  res:
    | {
        skippedLarge?: number;
        skippedLargeFiles?: Array<{ path: string; bytes: number }>;
        skippedBinary?: number;
      }
    | undefined,
): string {
  const large = res?.skippedLarge ?? 0;
  const binary = res?.skippedBinary ?? 0;
  if (!large && !binary) return "";
  const named = res?.skippedLargeFiles ?? [];
  const parts: string[] = [];
  if (large) {
    const list = named.map((f) => `${f.path} (${sizeLabel(f.bytes)})`).join(", ");
    parts.push(`${large} file(s) over the scan cap${list ? ` — ${list}` : ""}`);
  }
  if (binary) parts.push(`${binary} binary file(s)`);
  const how = named[0] ? ` Search a named file with grep({ path: "${named[0].path}" }).` : "";
  return `\n[not searched: ${parts.join("; ")}.${how}]`;
}

function clip(text: string): string {
  if (text.length <= CLIP_HEAD + CLIP_TAIL) return text;
  return `${text.slice(0, CLIP_HEAD)}\n...[truncated]...\n${text.slice(-CLIP_TAIL)}`;
}

/**
 * Git Bash path candidates on Windows, in pi's resolution order
 * (`docs/windows.md`): env override, Program Files, then PATH. Models write
 * POSIX quoting (`node -e "…"`), and cmd.exe mangles it into syntax errors that
 * cost whole steps - pi avoids this by running Git Bash, and so do we.
 */
let cachedShell: string | null | undefined;

function posixShell(): string | null {
  if (cachedShell !== undefined) return cachedShell;
  const override = process.env.ACPIO_SHELL;
  if (override) {
    cachedShell = existsSync(override) ? override : null;
    return cachedShell;
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      ...String(process.env.PATH ?? "")
        .split(";")
        .flatMap((dir) => (dir ? [`${dir}\\bash.exe`, `${dir}\\sh.exe`] : [])),
    ];
    cachedShell = candidates.find((p) => existsSync(p)) ?? null;
  } else {
    cachedShell = existsSync("/bin/sh") ? "/bin/sh" : "/bin/bash";
  }
  return cachedShell;
}

/** The agent talks to a shell, not to cmd.exe/sh directly — pipes, `&&`, globs work. */
export function shellCommand(command: string): { command: string; args: string[] } {
  const shell = posixShell();
  if (shell) return { command: shell, args: ["-c", command] };
  // No POSIX shell on this machine (rare on Windows): fall back to cmd.exe and
  // let the tool description tell the model to quote differently.
  return { command: "cmd.exe", args: ["/d", "/s", "/c", command] };
}

/** One `edit` entry as the model sends it. */
export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface PlannedReplacement {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Locate every replacement against the file as it is *now*, and reject the two
 * mistakes a model makes: an ambiguous anchor and edits that overlap. Applying
 * to the original text (not step by step) is what makes batched edits safe.
 */
export function planEdits(content: string, edits: EditSpec[]): PlannedReplacement[] {
  const plan: PlannedReplacement[] = [];
  for (const [index, edit] of edits.entries()) {
    const needle = edit.old_string;
    if (!needle) throw new Error(`edits[${index}].old_string is empty`);
    const starts: number[] = [];
    for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) {
      starts.push(at);
      if (!edit.replace_all && starts.length > 1) break;
    }
    if (!starts.length) {
      throw new Error(`edits[${index}].old_string not found — re-read the file and copy the text verbatim`);
    }
    if (starts.length > 1 && !edit.replace_all) {
      throw new Error(
        `edits[${index}].old_string matches ${starts.length} times — add surrounding context or set replace_all`,
      );
    }
    for (const start of starts) {
      plan.push({ start, end: start + needle.length, replacement: edit.new_string });
    }
  }

  plan.sort((a, b) => a.start - b.start);
  for (let i = 1; i < plan.length; i += 1) {
    if (plan[i]!.start < plan[i - 1]!.end) {
      throw new Error("edits overlap — merge them into one replacement or split them into separate calls");
    }
  }
  return plan;
}

/** Apply a plan back-to-front so earlier offsets stay valid. */
export function applyEdits(content: string, plan: PlannedReplacement[]): string {
  let next = content;
  for (const span of [...plan].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, span.start) + span.replacement + next.slice(span.end);
  }
  return next;
}

interface SearchHit {
  path: string;
  line: number;
  text: string;
}

// ── asking the user ──────────────────────────────────────────────────────────
//
// A question travels as the same ACP form elicitation the CLI agents use
// (`elicitation/create`), so the harness draws it with the card it already has
// and the answer comes back through the mapping it already runs. Everything the
// card shows — per-option descriptions, the "Other" field, its title — is built
// here from the call's arguments: none of it rides in the tool schema, and the
// schema is the part every request pays for.

/** Suffix the harness reads a question's own free-text field under. */
const OTHER_FIELD_SUFFIX = "__other";

export interface AskOption {
  id: string;
  label: string;
  description?: string;
}

/** One question as the model sends it. */
export interface AskQuestion {
  id: string;
  question: string;
  description?: string;
  options?: AskOption[];
  multiple?: boolean;
  /** Defaults to on: only an explicit `false` drops the "Other" field. */
  allow_free_text?: boolean;
}

/** Option entries in the shape the form's `oneOf`/`anyOf` carries. */
function askOptionEntries(options: AskOption[]) {
  return options.map((o) => ({
    const: o.id,
    title: o.label,
    ...(o.description ? { description: o.description } : {}),
  }));
}

/**
 * The form behind the question card. Options make a radio group (a checkbox
 * group with `multiple`); a question without options is a text field. All of it
 * is assembled here, so the model's own schema stays one line per question.
 */
export function askRequestedSchema(questions: AskQuestion[]): ElicitationRequestedSchema {
  const properties: NonNullable<ElicitationRequestedSchema["properties"]> = {};
  for (const q of questions) {
    const options = q.options ?? [];
    const described = q.description ? { description: q.description } : {};
    if (options.length && q.multiple) {
      properties[q.id] = {
        type: "array",
        title: q.question,
        ...described,
        items: { anyOf: askOptionEntries(options) },
      };
    } else if (options.length) {
      properties[q.id] = {
        type: "string",
        title: q.question,
        ...described,
        oneOf: askOptionEntries(options),
      };
    } else {
      properties[q.id] = { type: "string", title: q.question, ...described };
    }
    // "Other" sits next to the choices, never instead of them, and it is on by
    // default: the model asks for it only by switching it off
    // (`allow_free_text: false`). A checkbox group keeps the two apart — the
    // picked list answers the question itself, the typed words answer `__other`.
    if (options.length && q.allow_free_text !== false) {
      properties[`${q.id}${OTHER_FIELD_SUFFIX}`] = { type: "string", title: "Other" };
    }
  }
  return { type: "object", properties, required: questions.map((q) => q.id) };
}

/** One answer, in the words the card came back with. */
function answerLine(question: AskQuestion, content: Record<string, unknown>): string {
  const value = content[question.id];
  const picked = Array.isArray(value)
    ? value.map(String)
    : typeof value === "string" && value.trim()
      ? [value]
      : [];
  const other = content[`${question.id}${OTHER_FIELD_SUFFIX}`];
  const own = typeof other === "string" ? other.trim() : "";
  const quoted = picked.map((p) => JSON.stringify(p)).join(", ");
  if (quoted && own) return `- ${question.id}: ${quoted} — their own words: ${JSON.stringify(own)}`;
  // A card answered in the "Other" field carries no picked option: those words
  // are the answer, and saying "no answer" over them would lose it.
  if (own) return `- ${question.id}: ${JSON.stringify(own)} (their own words)`;
  if (quoted) return `- ${question.id}: ${quoted}`;
  return `- ${question.id}: (no answer)`;
}

/**
 * The `ask` input, written as JSON Schema by hand: `jsonSchema` hands these
 * bytes to the provider verbatim, where the zod converter would add `$schema`
 * and an `additionalProperties` per level — 152 characters of scaffolding the
 * model reads in every request and the form builder has no use for. Arguments
 * then arrive unvalidated, so {@link readAskInput} does what zod did for the
 * other tools.
 */
const ASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          description: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["id", "label"],
            },
          },
          multiple: { type: "boolean" },
          allow_free_text: { type: "boolean" },
        },
        required: ["id", "question"],
      },
    },
  },
  required: ["questions"],
};

/** A string field, trimmed — empty for anything that is not a string. */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readAskOptions(value: unknown): AskOption[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error("ask: `options` must be an array of { id, label }");
  const options = value.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id = asText(row.id);
    const label = asText(row.label) || id;
    if (!id) throw new Error("ask: every option needs an `id` and a `label`");
    const description = asText(row.description);
    return { id, label, ...(description ? { description } : {}) };
  });
  return options.length ? options : undefined;
}

/**
 * What {@link jsonSchema} leaves to us: the model's arguments arrive as sent, so
 * a malformed call has to come back as a sentence it can act on instead of as a
 * crash inside the form builder.
 */
function readAskInput(input: unknown): AskQuestion[] {
  const rows = (input as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error(
      "ask: send a non-empty `questions` array of { id, question, description?, options?, " +
        "multiple?, allow_free_text? }",
    );
  }
  return rows.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id = asText(row.id);
    const question = asText(row.question);
    if (!id || !question) throw new Error("ask: every question needs an `id` and a `question`");
    const description = asText(row.description);
    const options = readAskOptions(row.options);
    return {
      id,
      question,
      ...(description ? { description } : {}),
      ...(options ? { options } : {}),
      ...(row.multiple === true ? { multiple: true } : {}),
      // Only an explicit `false` opts out — an absent flag leaves the field on.
      ...(row.allow_free_text === false ? { allow_free_text: false } : {}),
    };
  });
}

/**
 * The tool result: one line per answer and nothing else. The questions and their
 * options already stand in the call above it, so repeating them here would buy
 * the model no information and cost every later request.
 */
export function renderAskAnswers(
  questions: AskQuestion[],
  content: Record<string, unknown>,
): string {
  return `The user answered:\n${questions.map((q) => answerLine(q, content)).join("\n")}`;
}

/**
 * The built-in agent's tool set. Mutating tools go through the harness's
 * `session/request_permission`, so `permissionPolicy` and the allowlist in
 * Settings behave exactly like they do for Cursor/OMP. Plan/ask modes get the
 * read-only tools only — enforced here, not by prompt text.
 */
export function createBuiltinTools(opts: BuiltinToolOptions): ToolSet {
  const { host, ask, mode, outsideCwd, sessionId } = opts;
  const taskTool: ToolSet = opts.subagents ? { task: makeTaskTool(opts.subagents) } : {};

  const read = tool({
    description:
      "Read a UTF-8 text file. A bare call returns the first 400 lines / 12KB; pass `line`/`limit` " +
      "for a bigger window (up to 2000 lines / 50KB), or continue from the reported line. For one " +
      "long line use `char_offset` (1-based) and `char_limit`.",
    inputSchema: z.object({
      path: z.string().describe("File path."),
      line: z.number().int().positive().optional().describe("1-based first line to read."),
      limit: z.number().int().positive().optional().describe("Max lines to return."),
      char_offset: z.number().int().positive().optional(),
      char_limit: z.number().int().positive().optional(),
    }),
    execute: async ({ path, line, limit, char_offset, char_limit }) => {
      const res = await host.request<{ content?: string; totalLines?: number }>("fs/read_text_file", {
        path,
        ...(line ? { line } : {}),
        ...(limit ? { limit } : {}),
      });
      const content = (res?.content || "").replace(/\r\n/g, "\n");
      if (!content) return "(empty file)";
      if (char_offset != null) {
        return charWindow(content, {
          path,
          from: char_offset,
          len: Math.min(char_limit ?? CHAR_WINDOW_CHARS, CHAR_WINDOW_CHARS),
        });
      }
      // A window the model asked for is honoured up to the caps; a bare call gets
      // the small default, so an unscoped read cannot flood the context.
      const asked = line != null || limit != null;
      const maxChars = asked ? READ_MAX_CHARS : READ_DEFAULT_CHARS;
      // One unbroken line: there is no `line: N` to continue from and no line cap
      // to raise, so the continuation is a character window.
      if (!content.includes("\n") && content.length > maxChars) {
        return (
          `${content.slice(0, maxChars)}\n...[truncated at ${maxChars} chars: ${path} is one ` +
          `${content.length}-character line; continue with char_offset: ${maxChars + 1}]...`
        );
      }
      return windowRead(
        content,
        path,
        line ?? 1,
        asked ? READ_MAX_LINES : READ_DEFAULT_LINES,
        maxChars,
        // The host knows the file's length even when it only sent back a slice.
        res?.totalLines,
      );
    },
  });

  const glob = tool({
    description:
      "List files matching a glob like `src/**/*.ts`, each with its size. " +
      (outsideCwd
        ? "The pattern's leading folders are the search area, so an absolute pattern " +
          "(`/repo/src/**/*.ts`) works too and reports absolute paths. "
        : "") +
      "Skips .git and node_modules.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern."),
      max_results: z.number().int().positive().max(MAX_GLOB_RESULTS).optional(),
    }),
    execute: async ({ pattern, max_results }) => {
      const res = await host.request<{
        files?: Array<{ path: string; bytes: number | null }>;
        truncated?: boolean;
      }>("fs/glob", {
        pattern,
        ...(max_results ? { max_results } : {}),
      });
      const files = res?.files ?? [];
      if (!files.length) return `No files match ${pattern}.`;
      const body = files
        .map((f) => `${sizeLabel(f.bytes).padStart(SIZE_COLUMN)}  ${f.path}`)
        .join("\n");
      return `${body}${res?.truncated ? `\n…(more matches, showing ${files.length})` : ""}`;
    },
  });

  const grep = tool({
    description:
      "Search file contents with a JS regex. Hits come grouped: a `path (size, N lines)` " +
      "header, then `line: text` under it. Skips .git, node_modules, binaries and huge files.",
    inputSchema: z.object({
      pattern: z.string().describe("JS regex, e.g. `calcTotal\\s*\\(`."),
      path: z.string().optional().describe("Subdirectory."),
      glob: z.string().optional().describe("Only search files matching this glob."),
      ignore_case: z.boolean().optional(),
      max_results: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(),
    }),
    execute: async ({ pattern, path, glob: fileGlob, ignore_case, max_results }) => {
      const res = await host.request<{
        hits?: SearchHit[];
        files?: Array<{ path: string; bytes: number; lines: number }>;
        truncated?: boolean;
        filesScanned?: number;
        skippedLarge?: number;
        skippedLargeFiles?: Array<{ path: string; bytes: number }>;
        skippedBinary?: number;
      }>("fs/search", {
        pattern,
        ...(path ? { path } : {}),
        ...(fileGlob ? { glob: fileGlob } : {}),
        ...(ignore_case ? { ignore_case: true } : {}),
        ...(max_results ? { max_results } : {}),
      });
      const hits = res?.hits ?? [];
      if (!hits.length) {
        return `No matches for /${pattern}/${ignore_case ? "i" : ""}${res?.truncated ? " (search stopped early)" : ""}.`;
      }
      // One header per file instead of the path on every hit: the model reads a
      // file's context once, and a long path repeated 200 times is dead weight.
      const meta = new Map((res?.files ?? []).map((f) => [f.path, f]));
      const body: string[] = [];
      let shown = "";
      for (const hit of hits) {
        if (hit.path !== shown) {
          const file = meta.get(hit.path);
          body.push(file ? `${hit.path} (${sizeLabel(file.bytes)}, ${file.lines} lines)` : hit.path);
          shown = hit.path;
        }
        body.push(`  ${hit.line}: ${hit.text}`);
      }
      return `${body.join("\n")}${res?.truncated ? "\n…(more matches than shown)" : ""}${notSearched(res)}`;
    },
  });

  // The one tool whose schema is hand-written (see ASK_INPUT_SCHEMA): every word
  // of it is paid for in every request, and the description is where the guidance
  // and the flags live so the properties can stay bare.
  const askUser = tool({
    description:
      "Ask the user one or more questions and wait for the answers. Use it when the decision is " +
      "theirs and you cannot find it out yourself. `options`: choices (`multiple`: several). " +
      "An \"Other\" field for their own words is on by default — `allow_free_text: false` hides it.",
    inputSchema: jsonSchema<unknown>(ASK_INPUT_SCHEMA),
    execute: async (input) => {
      const questions = readAskInput(input);
      const res = await host.request<{ action?: string; content?: Record<string, unknown> }>(
        "elicitation/create",
        {
          sessionId,
          mode: "form",
          message:
            questions.length === 1
              ? questions[0]!.question
              : `${questions.length} questions before I continue.`,
          requestedSchema: askRequestedSchema(questions),
        },
      );
      // A question left unanswered is an outcome, not a failure: the turn runs
      // on and the model states what it assumed instead of dying on the call.
      if (res?.action === "decline") {
        return (
          "The user declined to answer. Do not ask again — either continue on a stated " +
          "assumption, or stop and explain what you need."
        );
      }
      if (res?.action !== "accept") {
        return (
          "The question was left unanswered (skipped, or the turn was stopped). Ask again if it " +
          "still blocks you, otherwise continue and say what you assumed."
        );
      }
      return renderAskAnswers(questions, res.content ?? {});
    },
  });

  if (mode !== "agent") return { read, glob, grep, ask: askUser, ...taskTool };

  const write = tool({
    description:
      "Create or overwrite a file; parents are created. Prefer `edit` for an existing file. " +
      (outsideCwd ? "." : " — a path outside it is rejected."),
    inputSchema: z.object({
      path: z.string().describe("File path."),
      content: z.string().describe("Full new file content."),
    }),
    execute: async ({ path, content }) => {
      await ask({ title: `write ${path}`, kind: "edit", input: { path } });
      await host.request("fs/write_text_file", { path, content });
      return `Wrote ${content.length} characters to ${path}`;
    },
  });

  const edit = tool({
    description:
      "Replace exact text in a file; each `old_string` must match the file's current text exactly " +
      "once unless `replace_all` — read the file first and copy verbatim, including indentation.",
    inputSchema: z.object({
      path: z.string().describe("File path."),
      edits: z
        .array(
          z.object({
            old_string: z.string().describe("Exact text to replace, unique unless replace_all."),
            new_string: z.string().describe("Replacement text."),
            replace_all: z.boolean().optional().describe("Replace every occurrence."),
          }),
        )
        .min(1),
    }),
    execute: async ({ path, edits }) => {
      const { content } = await host.request<{ content: string }>("fs/read_text_file", { path });
      // Match in `\n`-land (what read shows), write back in the file's own EOL
      // style: the needle comes from read output, the file may be CRLF.
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const flat = content.replace(/\r\n/g, "\n");
      const normalized = edits.map((e) => ({
        old_string: e.old_string.replace(/\r\n/g, "\n"),
        new_string: e.new_string.replace(/\r\n/g, "\n"),
        ...(e.replace_all ? { replace_all: e.replace_all } : {}),
      }));
      const plan = planEdits(flat, normalized);
      await ask({ title: `edit ${path}`, kind: "edit", input: { path } });
      const next = applyEdits(flat, plan);
      await host.request("fs/write_text_file", {
        path,
        content: eol === "\r\n" ? next.replace(/\n/g, "\r\n") : next,
      });
      return `Replaced ${plan.length} occurrence(s) in ${path}`;
    },
  });

  const bash = tool({
    description:
      "Run a shell command in the working directory and wait for exit. Returns the exit code and output, " +
      "clipped to the first 4000 and last 2000 chars — pipe through `head`/`tail`/`grep` when the middle matters " +
      "instead of re-running it unchanged." +
      (posixShell() ? "" : " On Windows the command runs through cmd.exe, so quote for cmd.exe."),
    inputSchema: z.object({
      command: z.string().describe("Shell command."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_BASH_TIMEOUT_MS)
        .optional()
        .describe("Kill after this long (default 120s, max 300s)."),
    }),
    execute: async ({ command, timeout_ms }, ctx) => {
      await ask({ title: `bash ${command}`, kind: "execute", input: { command } });
      const shell = shellCommand(command);
      const { terminalId } = await host.request<{ terminalId: string }>("terminal/create", {
        ...shell,
        outputByteLimit: TERMINAL_BYTE_LIMIT,
      });
      // A cancelled turn must not leave the command running behind our back.
      const signal = ctx.abortSignal;
      const onAbort = () => {
        void host.request("terminal/kill", { terminalId }).catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const exit = await host.request<{ exitCode: number | null; signal?: string | null }>(
          "terminal/wait_for_exit",
          { terminalId, timeoutMs: timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS },
        );
        const out = await host.request<{ output?: string; truncated?: boolean }>("terminal/output", {
          terminalId,
        });
        const how = exit?.signal ? `signal ${exit.signal}` : String(exit?.exitCode ?? 0);
        const body = clip(out?.output ?? "");
        return `exit code: ${how}${out?.truncated ? "\n(output was truncated by the host)" : ""}\n${body}`;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await host.request("terminal/release", { terminalId }).catch(() => undefined);
      }
    },
  });

  return { read, glob, grep, write, edit, bash, ask: askUser, ...taskTool };
}
