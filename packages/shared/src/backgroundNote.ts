/**
 * The completion note acpio's background runner puts into a chat when a job
 * settles. It is delivered as a prompt — the agent must wake up with it — so the
 * transcript keeps it as an ordinary user message. This module is what tells that
 * message apart from something the reader typed, and takes it apart for the
 * collapsed block the chat draws instead of a user bubble.
 *
 * The shape parsed here is the one `formatBackgroundJobNote` writes
 * (apps/server/src/services/backgroundJobs.ts); the round-trip test in
 * apps/server/test/backgroundJobs.test.ts pins the two together. A note written
 * earlier keeps its own template, so every field is optional and unrecognized
 * lines survive in `rest` — the reader still sees the whole note.
 */

/** First line of every note, in each locale the server writes it in. */
const NOTE_MARKERS = ["[Фоновая задача]", "[Background task]"];

/**
 * The head line: label, status words, exit code, duration, job id. Both locales
 * are accepted in one pattern — a chat keeps the note in the language it was
 * written in, while the reader's UI may have switched language since.
 */
const HEAD =
  /^\[(?:Фоновая задача|Background task)\]\s*[«"]([\s\S]*?)[»"]\s*([\s\S]*?):\s*(?:код|exit)\s*(.+?),\s*(?:длительность|took)\s*(.+?)\s*\(id\s*([^()]*)\)\.?$/;

const STATUS_WORDS: Array<[BackgroundJobNoteStatus, RegExp]> = [
  ["killed", /^(?:остановлена|was stopped)$/i],
  ["failed", /^(?:завершилась с ошибкой|failed)$/i],
  ["exited", /^(?:завершилась|finished)$/i],
  ["running", /^(?:всё ещё выполняется|still running)$/i],
];

const COMMAND_LINE = /^(?:Команда|Command): ([\s\S]+)$/;
const LOG_LINE = /^(?:Лог|Log): ([\s\S]+)$/;
const OUTPUT_HEAD = /^(?:Последние строки вывода|Last output lines):$/;
const NO_OUTPUT = /^(?:Вывода нет\.|No output\.)$/;
/** Last line of the note: what to read next, addressed to the agent. */
const HINT_LINE = /^(?:Читай лог|Продолжи вывод|Read the log|Continue output)/;

export type BackgroundJobNoteStatus = "running" | "exited" | "failed" | "killed" | "unknown";

export interface BackgroundJobNote {
  /** `bg-3` — the id the follow-up tools take. */
  id: string | null;
  /** The job's own name, as the agent gave it. */
  label: string | null;
  status: BackgroundJobNoteStatus;
  exitCode: string | null;
  /** Already formatted by the server (`10s`, `2m 5s`). */
  elapsed: string | null;
  /** The shell command that ran. */
  command: string | null;
  logPath: string | null;
  /** The output tail riding inside the note; null when it carries none. */
  output: string | null;
  /** The note said the job produced no output. */
  emptyOutput: boolean;
  /** Where to read more — addressed to the agent, shown dimmed. */
  hint: string | null;
  /** Lines of a template this parser does not know, kept verbatim. */
  rest: string[];
}

/** Is this user message one of the background runner's notes? */
export function isBackgroundJobNote(text: string): boolean {
  const trimmed = text.trimStart();
  return NOTE_MARKERS.some((marker) => trimmed.startsWith(marker));
}

/**
 * Take one note apart for the note block. Null for anything that is not a note,
 * so a caller can hand it every user message.
 */
export function parseBackgroundJobNote(text: string): BackgroundJobNote | null {
  if (!isBackgroundJobNote(text)) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const headLine = lines[0]!.trim();
  const head = HEAD.exec(headLine);
  const note: BackgroundJobNote = {
    id: head?.[5]?.trim() || null,
    label: head?.[1]?.trim() || null,
    status: head ? statusOf(head[2]!.trim()) : "unknown",
    exitCode: head?.[3]?.trim() || null,
    elapsed: head?.[4]?.trim() || null,
    command: null,
    logPath: null,
    output: null,
    emptyOutput: false,
    hint: null,
    rest: [],
  };
  // An unreadable head is not dropped: it goes to `rest` like any other line.
  if (!head) note.rest.push(lines[0]!);

  // The note's last line says where to read more. Pulled off first, so the tail
  // above it can be taken as one block.
  const lastIndex = lines.length - 1;
  if (lastIndex > 0 && HINT_LINE.test(lines[lastIndex]!.trim())) {
    note.hint = lines[lastIndex]!.trim();
    lines.pop();
  }

  const tail: string[] = [];
  let inBody = false;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (inBody) {
      // Inside the output block every line belongs to the log, blanks included.
      tail.push(line);
      continue;
    }
    if (!trimmed) continue;
    const command = COMMAND_LINE.exec(trimmed);
    if (command && note.command === null) {
      note.command = command[1]!.trim();
      continue;
    }
    const log = LOG_LINE.exec(trimmed);
    if (log && note.logPath === null) {
      note.logPath = log[1]!.trim();
      continue;
    }
    if (OUTPUT_HEAD.test(trimmed)) {
      inBody = true;
      continue;
    }
    if (NO_OUTPUT.test(trimmed)) {
      note.emptyOutput = true;
      continue;
    }
    note.rest.push(line);
  }
  if (inBody) {
    while (tail.length > 0 && tail[tail.length - 1]!.trim() === "") tail.pop();
    const body = tail.join("\n");
    if (body.trim()) note.output = body;
    else note.emptyOutput = true;
  }
  return note;
}

function statusOf(words: string): BackgroundJobNoteStatus {
  for (const [status, pattern] of STATUS_WORDS) {
    if (pattern.test(words)) return status;
  }
  return "unknown";
}
