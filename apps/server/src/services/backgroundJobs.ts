import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  BG_MCP_PATH,
  BG_MCP_SERVER_ID,
  BG_MCP_SERVER_NAME,
  bgMcpToolName,
  childProcessEnv,
  resolveServerPort,
  type AppLocale,
  type BackgroundJobDto,
  type BackgroundJobStatus,
  type McpServerConfig,
} from "@acpio/shared";
import { shellCommand } from "@acpio/adapter-builtin";
import { backgroundJobLogDir, backgroundJobLogPath } from "./bgLogs.js";
import { ProcessTextDecoder } from "./processText.js";
import { listSessionsByIds } from "./sessions.js";
import { broadcast } from "./wsHub.js";

/**
 * Background commands the agent starts through acpio's own MCP server: the
 * server spawns the shell, keeps its output and tells the chat when it ends.
 *
 * The runner mirrors what the harnesses do for themselves — omp's
 * `AsyncJobManager` registers a job, delivers the settled result back into the
 * conversation and lets the model poll it — but it lives here, so every
 * harness acpio drives (built-in, omp, cursor, opencode) gets the same tools
 * without the user configuring anything.
 *
 * Jobs are process state, not rows: a server restart drops them and their
 * output, exactly as it drops the agent runtimes they belong to.
 */

/** Hard ceiling for one log file: a runaway watcher must not fill the disk. */
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const LOG_FULL_MARK = "\n…[log truncated: this job reached the log size limit]\n";
/** Bytes read per step when a reader asks for the tail of a log. */
const TAIL_BLOCK_BYTES = 64 * 1024;
/** `tailLines` default for the `output` tool — enough for a failing test run's summary. */
export const DEFAULT_OUTPUT_TAIL_LINES = 200;
/** Characters one read may return — the caller passes its own ceiling. */
export const DEFAULT_OUTPUT_MAX_CHARS = 24_000;
/** Running jobs at once: per chat, and across the whole server. */
const MAX_RUNNING_PER_SESSION = 6;
const MAX_RUNNING_JOBS = 24;
/** Finished jobs kept for the page and for the agent to read back. */
const MAX_FINISHED_JOBS = 40;
/**
 * Output that rides inside the completion note. Kept small on purpose: the note
 * stays in the transcript forever, while the full log is one `read` away — so
 * the note carries a taste of the output and the path, not the output.
 */
const NOTE_TAIL_LINES = 25;
const NOTE_TAIL_CHARS = 1_500;
/** A shell that ignores SIGTERM this long gets SIGKILL. */
const KILL_GRACE_MS = 3_000;
const MAX_SCRIPT_CHARS = 8_000;
const MAX_LABEL_CHARS = 80;

type BackgroundJobRecord = {
  id: string;
  sessionId: string;
  sessionTitle: string;
  cwd: string;
  label: string;
  script: string;
  pid: number | null;
  status: BackgroundJobStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  child: ChildProcess | null;
  /** Code page of the shell's output, decided by its first non-ASCII chunk. */
  decoder: ProcessTextDecoder;
  /** File stdout+stderr is appended to; deleted with the job row. */
  logPath: string;
  /** Open descriptor of `logPath` while the job writes to it. */
  logFd: number | null;
  /** Bytes in `logPath` — the reader's cursor and the row's `outputBytes`. */
  logBytes: number;
  /** The size ceiling was hit; nothing more is appended. */
  logFull: boolean;
  /** Who stopped it, while a stop is in flight — see {@link stopBackgroundJob}. */
  stoppedBy: "user" | "agent" | null;
};

const jobs = new Map<string, BackgroundJobRecord>();
/** Insertion order of finished jobs, oldest first — the eviction queue. */
const finishedOrder: string[] = [];
let seq = 0;

/**
 * Per-boot secret in the MCP URL. The endpoint spawns shells as this user, so
 * it must not answer a request that merely guessed the path: the URL is handed
 * to an agent process over ACP, and only that process (or someone reading it)
 * knows the token.
 */
const MCP_TOKEN = randomBytes(16).toString("hex");

/** Hook that hands a settled job to the chat. Wired in `index.ts` — the job
 *  runner must not import the session manager, which imports it back. */
type JobDoneHandler = (job: BackgroundJobDto) => void;
let onJobDone: JobDoneHandler | null = null;

export function setBackgroundJobDoneHandler(handler: JobDoneHandler | null): void {
  onJobDone = handler;
}

function toDto(record: BackgroundJobRecord): BackgroundJobDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    sessionTitle: record.sessionTitle,
    cwd: record.cwd,
    label: record.label,
    script: record.script,
    logPath: record.logPath,
    pid: record.pid,
    status: record.status,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    outputBytes: record.logBytes,
  };
}


function publish(record: BackgroundJobRecord) {
  broadcast({ type: "bg.updated", job: toDto(record) });
}

function removeRecord(id: string) {
  const record = jobs.get(id);
  if (record) {
    closeLog(record);
    rmSync(record.logPath, { force: true });
    // The chat's folder goes with its last log — a finished chat must not leave
    // an empty directory behind.
    try {
      rmdirSync(path.dirname(record.logPath));
    } catch {
      /* still holds another job's log */
    }
  }
  jobs.delete(id);
  const at = finishedOrder.indexOf(id);
  if (at >= 0) finishedOrder.splice(at, 1);
}

function closeLog(record: BackgroundJobRecord) {
  if (record.logFd == null) return;
  try {
    closeSync(record.logFd);
  } catch {
    /* already gone */
  }
  record.logFd = null;
}

function runningCount(sessionId?: string): number {
  let total = 0;
  for (const record of jobs.values()) {
    if (record.status !== "running") continue;
    if (sessionId && record.sessionId !== sessionId) continue;
    total += 1;
  }
  return total;
}

/** One line naming the job in the UI: the model's own label, else the command. */
function defaultLabel(script: string): string {
  const line = script.split("\n").find((part) => part.trim()) ?? script;
  const trimmed = line.trim().replace(/\s+/g, " ");
  return trimmed.length > MAX_LABEL_CHARS ? `${trimmed.slice(0, MAX_LABEL_CHARS - 1)}…` : trimmed;
}

/**
 * Append a chunk to the job's log. Written straight to the file — a reader may
 * look at a running job's log at any moment and must see what the shell has
 * already printed, not what a stream buffer has not flushed yet.
 */
function appendOutput(record: BackgroundJobRecord, chunk: Buffer | string) {
  if (record.logFull || record.logFd == null) return;
  // A Windows tool prints in its OEM code page (CP866 for Russian messages):
  // the log is text the agent has to read, so decode it here, once.
  const text = typeof chunk === "string" ? chunk : record.decoder.decode(chunk);
  const bytes = Buffer.byteLength(text);
  if (record.logBytes + bytes > MAX_LOG_BYTES) {
    const mark = LOG_FULL_MARK;
    try {
      writeSync(record.logFd, mark);
      record.logBytes += Buffer.byteLength(mark);
    } catch {
      /* the disk went away — the job's exit code still settles the row */
    }
    record.logFull = true;
    return;
  }
  try {
    writeSync(record.logFd, text);
    record.logBytes += bytes;
  } catch {
    /* same: a log that cannot be written must not kill the job */
  }
}

/** Kill the shell and whatever it started: a build's child process outlives its parent. */
function killTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    // `child.kill()` ends only the shell; `/T` takes the tree with it.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
      "error",
      () => {},
    );
    return;
  }
  try {
    // POSIX jobs get their own process group (see `detached` below), so the
    // negative pid reaches every child.
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function settle(record: BackgroundJobRecord, status: BackgroundJobStatus, exitCode: number | null) {
  closeLog(record);
  record.status = status;
  record.exitCode = exitCode;
  record.endedAt = Date.now();
  record.child = null;
  // The pid belongs to a live process: once reaped the OS may hand the number
  // to someone else, and a row that kept it would offer a wrong "stop this".
  record.pid = null;
  finishedOrder.push(record.id);
  // The page lists finished jobs too, but it is a log of what happened, not an
  // archive: the oldest rows go once there are more than the cap.
  while (finishedOrder.length > MAX_FINISHED_JOBS) {
    const oldest = finishedOrder.shift();
    if (!oldest) break;
    const dropped = jobs.get(oldest);
    if (!dropped || dropped.status === "running") continue;
    removeRecord(oldest);
    broadcast({ type: "bg.removed", jobIds: [oldest] });
  }
  publish(record);
  // The agent's own `stop` call is its own notification; a user's stop is news
  // the model still needs, so only that one is delivered as a note.
  if (record.stoppedBy !== "agent") onJobDone?.(toDto(record));
}

export interface StartBackgroundJobInput {
  sessionId: string;
  /** Folder the command runs in — the chat's cwd unless the model asked otherwise. */
  cwd: string;
  script: string;
  label?: string;
}

/**
 * Spawn `script` in the background and return the job row the model and the UI
 * both read. Throws a message fit for the model when the job is refused
 * (empty command, missing folder, too many running jobs).
 */
export async function startBackgroundJob(input: StartBackgroundJobInput): Promise<BackgroundJobDto> {
  const script = input.script.trim();
  if (!script) throw new Error("Command is empty");
  if (script.length > MAX_SCRIPT_CHARS) {
    throw new Error(`Command is too long (${script.length} > ${MAX_SCRIPT_CHARS} characters)`);
  }
  const cwd = path.resolve(input.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`Folder does not exist: ${cwd}`);
  }
  if (runningCount(input.sessionId) >= MAX_RUNNING_PER_SESSION) {
    throw new Error(
      `This chat already runs ${MAX_RUNNING_PER_SESSION} background jobs — stop one first (${bgMcpToolName("stop")}).`,
    );
  }
  if (runningCount() >= MAX_RUNNING_JOBS) {
    throw new Error(`The server already runs ${MAX_RUNNING_JOBS} background jobs — stop one first.`);
  }

  const session = (await listSessionsByIds([input.sessionId]))[0];
  if (!session) throw new Error("Chat not found");

  const { command, args } = shellCommand(script);
  const child = spawn(command, args, {
    cwd,
    env: childProcessEnv(),
    windowsHide: true,
    // POSIX: its own process group, so stopping the job stops its children too.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const id = `bg-${++seq}`;
  const logPath = backgroundJobLogPath(input.sessionId, id);
  let logFd: number | null = null;
  try {
    mkdirSync(backgroundJobLogDir(input.sessionId), { recursive: true });
    logFd = openSync(logPath, "a");
  } catch {
    // The job runs either way: a log that cannot be opened only costs the
    // reader the output.
  }

  const record: BackgroundJobRecord = {
    id,
    sessionId: input.sessionId,
    sessionTitle: session.title,
    cwd,
    decoder: new ProcessTextDecoder(),
    label: (input.label ?? "").trim().slice(0, MAX_LABEL_CHARS) || defaultLabel(script),
    script,
    logPath,
    logFd,
    logBytes: 0,
    logFull: false,
    pid: child.pid ?? null,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    child,
    stoppedBy: null,
  };
  jobs.set(record.id, record);

  child.stdout?.on("data", (chunk: Buffer | string) => appendOutput(record, chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => appendOutput(record, chunk));
  child.on("error", (err) => {
    appendOutput(record, `\n[job error] ${err.message}\n`);
    if (record.status === "running") settle(record, "failed", null);
  });
  child.on("exit", (code, signal) => {
    if (record.status !== "running") return;
    if (record.stoppedBy) settle(record, "killed", code);
    else if (signal) settle(record, "failed", null);
    else settle(record, code === 0 ? "exited" : "failed", code);
  });

  publish(record);
  return toDto(record);
}

/** Every job, running first and newest first inside each group. */
export function listBackgroundJobs(): BackgroundJobDto[] {
  return [...jobs.values()]
    .map(toDto)
    .sort((a, b) => {
      const running = Number(b.status === "running") - Number(a.status === "running");
      return running !== 0 ? running : b.startedAt - a.startedAt;
    });
}

export function getBackgroundJob(id: string): BackgroundJobDto | null {
  const record = jobs.get(id);
  return record ? toDto(record) : null;
}

export interface BackgroundJobOutput {
  job: BackgroundJobDto;
  text: string;
  /** Byte offset of the first returned character in the log file. */
  from: number;
  /** Byte offset just past the last returned character — the next read's cursor. */
  to: number;
  /** True when this read did not cover the whole log (older or newer output). */
  dropped: boolean;
}

/** Size of a log file, 0 when it does not exist (a job whose log could not open). */
function logSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

function countNewlines(buf: Buffer): number {
  let seen = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) seen += 1;
  return seen;
}

/**
 * A byte range that does not start at the file's beginning may cut a character
 * in half (a chunk boundary of whatever wrote it): decoding leaves a U+FFFD in
 * front, which is dropped rather than shown to the reader.
 */
function decodeRange(buf: Buffer, offsetInFile: number): string {
  const text = buf.toString("utf8");
  return offsetInFile > 0 && text.startsWith("\uFFFD") ? text.slice(1) : text;
}

/**
 * Index of the first character of the last `lines` lines of `text`. A trailing
 * newline ends the last line instead of starting an empty one, so `tailLines: 1`
 * is the last line a reader would name.
 */
function lastLinesStart(text: string, lines: number): number {
  let end = text.length;
  if (end > 0 && text[end - 1] === "\n") end -= 1;
  let seen = 0;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (text[i] !== "\n") continue;
    seen += 1;
    if (seen >= lines) return i + 1;
  }
  return 0;
}

/** Half a surrogate pair — a cut must not land between the two units. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Start index that keeps at most `maxChars` characters of `text`. */
function trimToChars(text: string, start: number, maxChars: number): number {
  if (text.length - start <= maxChars) return start;
  const cut = text.length - maxChars;
  return isLowSurrogate(text.charCodeAt(cut)) ? cut + 1 : cut;
}

/** Last `lines` lines of a log, capped at `maxChars` characters. */
function readLogTail(
  logPath: string,
  lines: number,
  maxChars: number,
): { text: string; from: number; to: number } {
  const size = logSize(logPath);
  if (!size) return { text: "", from: 0, to: 0 };
  const fd = openSync(logPath, "r");
  try {
    let pos = size;
    let buf = Buffer.alloc(0);
    let newlines = 0;
    // One line more than asked keeps the first line whole when it starts mid-file.
    while (pos > 0 && newlines <= lines) {
      const len = Math.min(TAIL_BLOCK_BYTES, pos);
      pos -= len;
      const chunk = Buffer.allocUnsafe(len);
      readSync(fd, chunk, 0, len, pos);
      buf = Buffer.concat([chunk, buf]);
      newlines += countNewlines(chunk);
    }
    const text = decodeRange(buf, pos);
    const start = trimToChars(text, lastLinesStart(text, lines), maxChars);
    return {
      text: text.slice(start),
      from: pos + Buffer.byteLength(text.slice(0, start)),
      to: size,
    };
  } finally {
    closeSync(fd);
  }
}

/** Everything written after `from`, capped at `maxChars` characters. */
function readLogFrom(
  logPath: string,
  from: number,
  maxChars: number,
): { text: string; from: number; to: number } {
  const size = logSize(logPath);
  if (from >= size) return { text: "", from, to: size };
  const fd = openSync(logPath, "r");
  try {
    // UTF-8 never spends more than 4 bytes on a character, so this reads
    // enough to fill the character budget without pulling the whole file in.
    const len = Math.min(size - from, maxChars * 4 + 4);
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, from);
    const text = decodeRange(buf, from);
    // The character budget cuts the end, and never in half a surrogate pair.
    const cut = Math.min(text.length, maxChars);
    const end =
      cut < text.length && isLowSurrogate(text.charCodeAt(cut)) ? cut + 1 : cut;
    const slice = text.slice(0, end);
    return { text: slice, from, to: from + Buffer.byteLength(slice) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Output of one job, either its last `tailLines` or everything written after
 * `since` (the offset a previous read returned as `to`). Both read the log file
 * itself, so a reader sees exactly what the shell has printed so far.
 */
export function readBackgroundJobOutput(
  id: string,
  options: { tailLines?: number; since?: number; maxChars?: number } = {},
): BackgroundJobOutput | null {
  const record = jobs.get(id);
  if (!record) return null;
  const maxChars = Math.max(1, Math.trunc(options.maxChars ?? DEFAULT_OUTPUT_MAX_CHARS));
  const size = logSize(record.logPath);
  const since =
    typeof options.since === "number" && Number.isFinite(options.since)
      ? Math.min(Math.max(Math.trunc(options.since), 0), size)
      : null;
  const read =
    since != null
      ? readLogFrom(record.logPath, since, maxChars)
      : readLogTail(
          record.logPath,
          Math.max(1, Math.trunc(options.tailLines ?? DEFAULT_OUTPUT_TAIL_LINES)),
          maxChars,
        );
  return {
    job: toDto(record),
    text: read.text,
    from: read.from,
    to: read.to,
    dropped: read.from > 0 || read.to < size,
  };
}

/**
 * Stop a job. `by` decides who is told: the agent that called the `stop` tool
 * already knows, a user clicking Stop in the UI does not — the model still has
 * to hear that its work was cancelled, so that settle is delivered as a note.
 */
export function stopBackgroundJob(id: string, by: "user" | "agent" = "user"): BackgroundJobDto | null {
  const record = jobs.get(id);
  if (!record) return null;
  if (record.status !== "running" || !record.child) return toDto(record);
  record.stoppedBy = by;
  const child = record.child;
  killTree(child);
  const hardKill = setTimeout(() => {
    if (record.status !== "running") return;
    killTree(child);
  }, KILL_GRACE_MS);
  hardKill.unref?.();
  return toDto(record);
}

/** Drop a finished job from the list. A running one must be stopped first. */
export function forgetBackgroundJob(id: string): boolean {
  const record = jobs.get(id);
  if (!record || record.status === "running") return false;
  removeRecord(id);
  broadcast({ type: "bg.removed", jobIds: [id] });
  return true;
}

/** "Очистить завершённые" on the tasks page. */
export function clearFinishedBackgroundJobs(): string[] {
  const ids = [...jobs.values()].filter((record) => record.status !== "running").map((r) => r.id);
  for (const id of ids) removeRecord(id);
  if (ids.length) broadcast({ type: "bg.removed", jobIds: ids });
  return ids;
}

/**
 * Point acpio's own background runner at this boot's endpoint. The server is
 * already part of the chat's effective MCP list (and already filtered by the
 * global, folder and chat switches); the shared registry carries the path only,
 * while the live url needs the server's port and the token the agent is handed.
 * Both the boot path and the "did this chat's MCP list change" check go through
 * here, so the resolved url never looks like an edit that restarts the agent.
 */
export function resolveBackgroundMcp(servers: McpServerConfig[], sessionId: string): McpServerConfig[] {
  return servers.map((s) => (s.id === BG_MCP_SERVER_ID ? { ...s, url: backgroundMcpUrl(sessionId) } : s));
}

function backgroundMcpUrl(sessionId: string): string {
  return `http://127.0.0.1:${resolveServerPort()}${BG_MCP_PATH}?session=${encodeURIComponent(
    sessionId,
  )}&token=${MCP_TOKEN}`;
}

/** True when the request carries the token the endpoint was handed this boot. */
export function backgroundMcpTokenMatches(token: string | undefined): boolean {
  return typeof token === "string" && token.length > 0 && token === MCP_TOKEN;
}

function statusText(job: BackgroundJobDto, locale: AppLocale): string {
  const ru = locale === "ru";
  switch (job.status) {
    case "running":
      return ru ? "всё ещё выполняется" : "still running";
    case "exited":
      return ru ? "завершилась" : "finished";
    case "killed":
      return ru ? "остановлена" : "was stopped";
    default:
      return ru ? "завершилась с ошибкой" : "failed";
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The note the chat receives when a job settles. It carries the tail of the
 * output — like omp's `async-result` message — so the agent can act on a
 * failure without a round trip, and names the tools that read more.
 */
export function formatBackgroundJobNote(job: BackgroundJobDto, tail: string, locale: AppLocale): string {
  const ru = locale === "ru";
  const elapsed = formatElapsed((job.endedAt ?? Date.now()) - job.startedAt);
  const exit = job.exitCode == null ? "—" : String(job.exitCode);
  const clipped = tail.length > NOTE_TAIL_CHARS ? tail.slice(-NOTE_TAIL_CHARS) : tail;
  const head = ru
    ? `[Фоновая задача] «${job.label}» ${statusText(job, locale)}: код ${exit}, длительность ${elapsed} (id ${job.id}).`
    : `[Background task] "${job.label}" ${statusText(job, locale)}: exit ${exit}, took ${elapsed} (id ${job.id}).`;
  const command = ru ? `Команда: ${job.script}` : `Command: ${job.script}`;
  const body = clipped.trim()
    ? `${ru ? "Последние строки вывода" : "Last output lines"}:\n${clipped.trimEnd()}`
    : ru
      ? "Вывода нет."
      : "No output.";
  const log = ru ? `Лог: ${job.logPath}` : `Log: ${job.logPath}`;
  const how = ru
    ? `Читай лог окнами через read или ищи в нём grep; хвост — ${bgMcpToolName("output")}({ jobId: "${job.id}" }), остальные задачи — ${bgMcpToolName("list")}().`
    : `Read the log with read (windows) or grep; tail — ${bgMcpToolName("output")}({ jobId: "${job.id}" }), other jobs — ${bgMcpToolName("list")}().`;
  return [head, command, log, body, how].join("\n");
}

/** Tail used inside the completion note. */
export function backgroundJobNoteTail(id: string): string {
  const read = readBackgroundJobOutput(id, {
    tailLines: NOTE_TAIL_LINES,
    maxChars: NOTE_TAIL_CHARS,
  });
  return read?.text ?? "";
}
