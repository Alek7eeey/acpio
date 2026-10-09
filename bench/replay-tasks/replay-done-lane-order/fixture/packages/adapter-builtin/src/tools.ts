import { existsSync } from "node:fs";
import type { AgentMode } from "@acpio/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { HostClient } from "./host.js";

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
}

/** Terminal output the model gets: enough to act on, bounded for the context. */
const CLIP_HEAD = 8_000;
const CLIP_TAIL = 8_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 300_000;
const TERMINAL_BYTE_LIMIT = 64 * 1024;
const MAX_SEARCH_RESULTS = 200;
const MAX_GLOB_RESULTS = 500;
/** Read contract, pi's numbers: whichever cap is hit first ends the window. */
const READ_MAX_LINES = 2_000;
const READ_MAX_CHARS = 50_000;

/**
 * Bound what a single `read` hands the model and say how to continue. Without
 * this a big file lands whole in the context, and the model has no idea it
 * could page - pi's read discloses exactly this window and the way to walk it.
 * Slicing is byte-faithful (no line-ending normalization).
 */
export function windowRead(content: string, path: string, fromLine: number): string {
  const totalLines = content.split("\n").length;
  let end = content.length;
  let linesShown = totalLines;
  if (totalLines > READ_MAX_LINES) {
    let idx = -1;
    for (let i = 0; i < READ_MAX_LINES; i++) {
      idx = content.indexOf("\n", idx + 1);
      if (idx < 0) break;
    }
    end = idx < 0 ? content.length : idx + 1;
    linesShown = READ_MAX_LINES;
  }
  if (end > READ_MAX_CHARS) {
    end = READ_MAX_CHARS;
    linesShown = content.slice(0, end).split("\n").length;
  }
  if (end >= content.length) return content;
  const nextLine = fromLine + linesShown;
  return (
    `${content.slice(0, end)}\n...[truncated at ${linesShown} lines / ${READ_MAX_CHARS} chars: ` +
    `${path} has ${totalLines} lines; continue with read({ path, line: ${nextLine} })]...`
  );
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

/**
 * The built-in agent's tool set. Mutating tools go through the harness's
 * `session/request_permission`, so `permissionPolicy` and the allowlist in
 * Settings behave exactly like they do for Cursor/OMP. Plan/ask modes get the
 * read-only tools only — enforced here, not by prompt text.
 */
export function createBuiltinTools(opts: BuiltinToolOptions): ToolSet {
  const { host, ask, mode } = opts;

  const read = tool({
    description:
      "Read a UTF-8 text file. Output is windowed to the first 2000 lines or 50KB, " +
      "whichever comes first; pass line/limit (1-based) to move through a larger file, " +
      "and continue from the reported line instead of re-reading the whole file. " +
      "Directories and missing files are rejected by the host.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path, or a path relative to the working directory."),
      line: z.number().int().positive().optional().describe("1-based first line to read."),
      limit: z.number().int().positive().optional().describe("Maximum number of lines to return."),
    }),
    execute: async ({ path, line, limit }) => {
      const res = await host.request<{ content?: string }>("fs/read_text_file", {
        path,
        ...(line ? { line } : {}),
        ...(limit ? { limit } : {}),
      });
      const content = res?.content || "";
      if (!content) return "(empty file)";
      return windowRead(content, path, line ?? 1);
    },
  });

  const glob = tool({
    description:
      "List workspace files whose path matches a glob (`*`, `?`, `**`; e.g. `src/**/*.ts`). " +
      "Use this instead of shelling out to find or ls — .git and node_modules are skipped.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob matched against the path relative to the working directory."),
      max_results: z.number().int().positive().max(MAX_GLOB_RESULTS).optional(),
    }),
    execute: async ({ pattern, max_results }) => {
      const res = await host.request<{ files?: string[]; truncated?: boolean }>("fs/glob", {
        pattern,
        ...(max_results ? { max_results } : {}),
      });
      const files = res?.files ?? [];
      if (!files.length) return `No files match ${pattern}.`;
      return `${files.join("\n")}${res?.truncated ? `\n…(more matches, showing ${files.length})` : ""}`;
    },
  });

  const grep = tool({
    description:
      "Search file contents with a JavaScript regular expression and return `path:line: text` hits. " +
      "Prefer this over shelling out to grep/findstr. .git, node_modules, binaries and huge files are skipped.",
    inputSchema: z.object({
      pattern: z.string().describe("JavaScript regular expression, e.g. `calcTotal\\s*\\(`."),
      path: z
        .string()
        .optional()
        .describe("Subdirectory to narrow the search, relative to the working directory."),
      glob: z.string().optional().describe("Only search files matching this glob, e.g. `**/*.mjs`."),
      ignore_case: z.boolean().optional(),
      max_results: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(),
    }),
    execute: async ({ pattern, path, glob: fileGlob, ignore_case, max_results }) => {
      const res = await host.request<{
        hits?: SearchHit[];
        truncated?: boolean;
        filesScanned?: number;
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
      const body = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n");
      return `${body}${res?.truncated ? "\n…(more matches than shown)" : ""}`;
    },
  });

  if (mode !== "agent") return { read, glob, grep };

  const write = tool({
    description:
      "Create or overwrite a file with exactly this content. The parent directory is created when missing. " +
      "Prefer edit for changes to an existing file.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path, or a path relative to the working directory."),
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
      "Replace exact text in a file. Send every change as one entry in `edits` — do not call this " +
      "once per line. Each `old_string` must match exactly once unless `replace_all` is set, no two " +
      "edits may overlap, and all of them apply to the file as it is now: read the file first and " +
      "copy the text verbatim, including indentation.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path, or a path relative to the working directory."),
      edits: z
        .array(
          z.object({
            old_string: z.string().describe("Exact text to replace; include enough context to be unique."),
            new_string: z.string().describe("Replacement text."),
            replace_all: z
              .boolean()
              .optional()
              .describe("Replace every occurrence instead of requiring exactly one."),
          }),
        )
        .min(1)
        .describe("One or more non-overlapping replacements, applied to the file as it is now."),
    }),
    execute: async ({ path, edits }) => {
      const { content } = await host.request<{ content: string }>("fs/read_text_file", { path });
      const plan = planEdits(content, edits);
      await ask({ title: `edit ${path}`, kind: "edit", input: { path } });
      await host.request("fs/write_text_file", { path, content: applyEdits(content, plan) });
      return `Replaced ${plan.length} occurrence(s) in ${path}`;
    },
  });

  const bash = tool({
    description:
      "Run a shell command in the working directory and wait for it to exit. " +
      "Returns the exit code and the captured output; long output is clipped to its first " +
      "and last 8000 characters, so narrow the command (pipe through `head`, `tail` or `grep`) " +
      "when the middle matters instead of re-running it unchanged. " +
      (posixShell()
        ? "The shell is POSIX (bash/sh) on every platform - pipes, &&, globs and single/double " +
          "quotes work as in bash, and paths use '/' (including on Windows)."
        : "On Windows the command runs through cmd.exe, so quote for cmd.exe."),
    inputSchema: z.object({
      command: z.string().describe("Shell command line (POSIX syntax when the shell is bash/sh)."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_BASH_TIMEOUT_MS)
        .optional()
        .describe("Kill the command after this long (default 120s, max 300s)."),
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

  return { read, glob, grep, write, edit, bash };
}
