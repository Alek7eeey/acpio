import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { estimateTokens } from "./loop.js";

/**
 * Addressable recall compaction (ARC): the bytes of a bulky tool result move to
 * a file of their own and the prompt carries a citation instead — preview, path
 * and length. Summaries and masking make that loss permanent; a file makes it
 * reversible, and it is read back with the `read` tool the agent already has, so
 * recall costs no tool schema in every request. Resolution never passes through a
 * ranker that could miss (99.00% vs 79.57% exact answers on needle-in-a-haystack,
 * arXiv 2607.25066).
 *
 * The id is a hash of the call, not of its place in the history, so the same
 * message turns into the same citation on every turn: the prefix stays stable
 * and the provider's prompt cache keeps hitting.
 */
export interface OffloadRecord {
  id: string;
  /** Tool that produced the bytes, for the citation's "how to read it back". */
  tool: string;
  /** Short subject (path, query) so a stub is answerable without a recall. */
  subject: string;
  text: string;
  tokens: number;
}

/**
 * Results that are never archived: a `read` window is exactly what the model
 * asked to see, byte for byte, and archiving it would hand back a preview of the
 * model's own request. Reads are bounded by their own window instead (see
 * `READ_DEFAULT_*`/`READ_MAX_*` in `tools.ts`), and a stale copy is still covered
 * by masking, which can simply be read again.
 */
const NEVER_OFFLOADED: readonly string[] = ["read"];

/**
 * Head and tail kept inline so the model can often answer without opening the
 * file at all. Split 2:1 the way `bash` clips its own output: the error that
 * makes the model reach for the archive sits at the *end* of a command's
 * output, and a head-only preview hides exactly that part for the same budget.
 */
export const OFFLOAD_PREVIEW_CHARS = 600;
const PREVIEW_HEAD_CHARS = 400;
const PREVIEW_TAIL_CHARS = OFFLOAD_PREVIEW_CHARS - PREVIEW_HEAD_CHARS;

/** Stable id for one tool result: same call ⇒ same id, restart after restart. */
export function offloadId(tool: string, toolCallId: string): string {
  return createHash("sha1").update(`${tool}\u0000${toolCallId}`).digest("hex").slice(0, 12);
}

/**
 * Folder holding one session's archived results. The host's read guard has to
 * know this layout as well — the archive lives outside the session cwd — so it
 * is derived here and imported by both sides instead of being written down twice.
 */
export function offloadDir(stateDir: string, sessionId: string): string {
  return join(stateDir, `${sessionId}.offload`);
}

/** Cited as `/`-separated: the model copies it into JSON, where `\\` needs escaping. */
function citedPath(file: string): string {
  return file.replace(/\\/g, "/");
}

/** One line, so the citation cannot be mistaken for the file it points at. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Head plus tail of `text`, with the omitted middle counted out loud. */
function previewOf(text: string): string {
  if (text.length <= OFFLOAD_PREVIEW_CHARS) return inline(text);
  const omitted = text.length - PREVIEW_HEAD_CHARS - PREVIEW_TAIL_CHARS;
  return (
    `${inline(text.slice(0, PREVIEW_HEAD_CHARS))} … (${omitted} chars omitted) … ` +
    inline(text.slice(-PREVIEW_TAIL_CHARS))
  );
}

/** The line that replaces an offloaded result in the prompt. */
export function offloadCitation(record: OffloadRecord, file: string): string {
  return (
    `[offloaded file=${citedPath(file)} tool=${record.tool} subject=${record.subject} ~${record.tokens} tokens]\n` +
    `preview: ${previewOf(record.text)}\n` +
    `The full result is in that file: read it back with the read tool (line="…" to continue` +
    ` past the first window). Do not guess from the preview when the exact text matters.`
  );
}

/**
 * One session's archive — plain text, one file per offloaded result, named by
 * the id. Plain text is the whole point: `read` can window it by line and
 * `bash` can grep it, with no recall tool to keep resident in every request.
 */
export class OffloadStore {
  private readonly written = new Set<string>();

  private constructor(private readonly dir: string) {}

  /** Archive for a session; `stateDir` is the same folder the session JSON lives in. */
  static forSession(stateDir: string, sessionId: string): OffloadStore {
    return new OffloadStore(offloadDir(stateDir, sessionId));
  }

  /** Write one record and return its path; the same id is never written twice. */
  put(record: OffloadRecord): string {
    const file = join(this.dir, `${record.id}.txt`);
    if (this.written.has(record.id) || existsSync(file)) return file;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, record.text, "utf8");
    this.written.add(record.id);
    return file;
  }
}

/** Pull the bytes out of one tool result part, whatever shape the tool returned. */
function resultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return "";
  const row = output as Record<string, unknown>;
  if (typeof row.value === "string") return row.value;
  if (typeof row.text === "string") return row.text;
  if (typeof row.content === "string") return row.content;
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

/**
 * Replace every archivable tool result above `minTokens` with its citation,
 * writing the bytes to `store` on the way. Deterministic in the message alone —
 * a result over the line is offloaded on every turn, so the prompt prefix never
 * changes for a reason the provider cannot cache.
 */
export function offloadToolResults(
  messages: ModelMessage[],
  store: OffloadStore,
  minTokens: number,
): ModelMessage[] {
  if (!(minTokens > 0)) return messages;
  // A result part carries no input of its own — the call that produced it does,
  // and the citation's subject (path, command, pattern) comes from there.
  const calls = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.set(part.toolCallId, part.input as Record<string, unknown>);
    }
  }
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      if (NEVER_OFFLOADED.includes(part.toolName)) return part;
      const text = resultText(part.output);
      if (!text) return part;
      const tokens = estimateTokens([{ role: "user", content: text }]);
      if (tokens < minTokens) return part;
      const id = offloadId(part.toolName, part.toolCallId);
      const input = calls.get(part.toolCallId);
      const subject =
        typeof input?.path === "string"
          ? input.path
          : typeof input?.command === "string"
            ? input.command.replace(/\s+/g, " ").slice(0, 80)
            : typeof input?.pattern === "string"
              ? input.pattern
              : part.toolName;
      const record: OffloadRecord = { id, tool: part.toolName, subject, text, tokens };
      const file = store.put(record);
      touched = true;
      return { ...part, output: { type: "text" as const, value: offloadCitation(record, file) } };
    });
    if (!touched) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}
