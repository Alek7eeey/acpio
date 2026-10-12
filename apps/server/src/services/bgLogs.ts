import { rmSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db/client.js";

/**
 * Where a background job's output goes: one file per chat under acpio's own
 * data folder. A log is a file, not an MCP answer, so the agent reads it with
 * the ordinary `read` (line windows) and `grep` — the same tools it uses on any
 * other file — instead of pulling the whole thing through a tool result.
 *
 * Kept in its own module because both sides need the paths and nothing else:
 * the runner writes them, and the session's read/search gate has to let the
 * agent touch this one folder outside the cwd.
 */
export const BG_LOGS_DIR = path.join(DATA_DIR, "bg-logs");

/**
 * Drop every log of the previous run. Jobs are process state — a boot loses the
 * rows, so the files they wrote would only sit there as orphans.
 */
export function resetBackgroundJobLogs(): void {
  rmSync(BG_LOGS_DIR, { recursive: true, force: true });
}

/** Folder holding one chat's job logs. */
export function backgroundJobLogDir(sessionId: string): string {
  return path.join(BG_LOGS_DIR, sessionId);
}

/** The log file of one job (also the row's `logPath`). */
export function backgroundJobLogPath(sessionId: string, jobId: string): string {
  return path.join(backgroundJobLogDir(sessionId), `${jobId}.log`);
}

/**
 * True when a path is a chat's own log folder or something inside it — what
 * lets the agent read and search the log of a job it started (the folder
 * itself included, since `grep` scopes to a folder), without opening another
 * chat's.
 */
export function isBackgroundJobLogPath(
  sessionId: string | null | undefined,
  target: string,
): boolean {
  if (!sessionId) return false;
  const rel = path.relative(backgroundJobLogDir(sessionId), path.resolve(target));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
