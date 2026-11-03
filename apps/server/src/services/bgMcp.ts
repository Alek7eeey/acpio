import path from "node:path";
import {
  BG_MCP_SERVER_NAME,
  bgMcpToolName,
  type BackgroundJobDto,
  type BgMcpTool,
} from "@acpio/shared";
import {
  DEFAULT_OUTPUT_MAX_CHARS,
  DEFAULT_OUTPUT_TAIL_LINES,
  getBackgroundJob,
  listBackgroundJobs,
  MAX_WAIT_MS,
  readBackgroundJobOutput,
  startBackgroundJob,
  stopBackgroundJob,
  waitForBackgroundJob,
} from "./backgroundJobs.js";
import { listSessionsByIds } from "./sessions.js";
import {
  handleServedMcpRequest,
  type ServedMcpResponse,
  type ServedMcpTool,
  type ServedToolResult,
} from "./servedMcp.js";

/**
 * The MCP server acpio is for its own chats: `run` starts a shell command in
 * the background, `job` is everything about one afterwards (read, wait, kill,
 * list). The JSON-RPC plumbing it answers with lives in `servedMcp.ts`, shared
 * with the endpoint plugins get.
 */

interface ToolDef {
  name: BgMcpTool;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP clients may skip a confirmation prompt for a read-only tool. */
  readOnly: boolean;
}

// These definitions ride every request a harness makes, so each one is trimmed
// to what the model needs to pick the tool and fill its fields: what it does,
// when to reach for it, and the argument meanings that are not obvious from the
// name. Two tools, not five: the four things done to a job share one result
// shape and one id, so they share one entry — the call's own arguments say
// which of them it is, and the split cost ~1500 chars of schema per request.
const TOOL_DEFS: ToolDef[] = [
  {
    name: "run",
    readOnly: false,
    description:
      "Run a shell command in the background (builds, tests, dev servers); returns its job id at once. " +
      "The chat gets its output tail when it finishes.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command, same shell as `bash`." },
        label: { type: "string", description: "Name shown in the UI." },
        cwd: { type: "string", description: "Folder, relative to the chat's." },
        // Absent → control comes straight back, which is what a server wants.
        // A number → block until the job ends (not that long: the wait ends with
        // the job), so a test run needs no `sleep` guess before reading it.
        waitMs: {
          type: "integer",
          description:
            `Block until it ends (max ${MAX_WAIT_MS}); its tail comes back too. ` +
            "Omit for a server or a watcher.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "job",
    readOnly: false,
    description:
      "A job by id: its output, wait for its end (timeoutMs), kill it (kill). " +
      "No jobId lists this chat's jobs.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job id from `run` (bg-N); omit to list jobs." },
        timeoutMs: {
          type: "integer",
          description:
            `Block until it ends (max ${MAX_WAIT_MS}); its tail comes back. ` +
            "Omit to read as it stands — that does not wait.",
        },
        tailLines: { type: "integer", description: `Lines from the end (default ${DEFAULT_OUTPUT_TAIL_LINES}).` },
        since: { type: "integer", description: "Cursor from a previous read." },
        kill: { type: "boolean", description: "Stop it and its process tree." },
      },
      additionalProperties: false,
    },
  },
];

function result(text: string, isError = false): ServedToolResult {
  return { text, ...(isError ? { isError: true } : {}) };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asInt(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : undefined;
}

function elapsedText(job: BackgroundJobDto): string {
  const ms = Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function jobLine(job: BackgroundJobDto): string {
  const exit = job.exitCode == null ? "" : ` exit ${job.exitCode}`;
  return `- ${job.id} [${job.status}${exit}] ${elapsedText(job)} — «${job.label}» in ${job.cwd}`;
}

function patienceText(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/** A job id from another chat is "unknown" here on purpose: one chat never reads another's output. */
function ownedJob(jobId: string, sessionId: string): BackgroundJobDto | null {
  const job = getBackgroundJob(jobId);
  if (!job || job.sessionId !== sessionId) return null;
  return job;
}

/** A settled job's tail, or what a running one has so far. */
function jobReport(
  job: BackgroundJobDto,
  args: Record<string, unknown>,
  empty = "(no output yet)",
): string {
  const read = readBackgroundJobOutput(job.id, {
    tailLines: asInt(args.tailLines) ?? DEFAULT_OUTPUT_TAIL_LINES,
    since: asInt(args.since),
    maxChars: DEFAULT_OUTPUT_MAX_CHARS,
  });
  const exit = job.exitCode == null ? "" : ` exit ${job.exitCode}`;
  return [
    `${job.id} [${job.status}${exit}] ${elapsedText(job)} — «${job.label}»`,
    `Log: ${job.logPath}`,
    read?.dropped ? "(not the whole log — read the file for the rest)" : "",
    `--- output (to=${read?.to ?? 0}) ---`,
    read?.text.trim() ? read!.text.replace(/\s+$/, "") : empty,
  ]
    .filter(Boolean)
    .join("\n");
}

async function callTool(
  name: BgMcpTool,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<ServedToolResult> {
  try {
    switch (name) {
      case "run": {
        const command = asString(args.command).trim();
        if (!command) return result("`command` is required.", true);
        const session = (await listSessionsByIds([sessionId]))[0];
        if (!session) return result("This chat no longer exists.", true);
        const cwdArg = asString(args.cwd).trim();
        const cwd = cwdArg ? path.resolve(session.cwd || process.cwd(), cwdArg) : session.cwd;
        const job = await startBackgroundJob({
          sessionId,
          cwd: cwd || process.cwd(),
          script: command,
          label: asString(args.label),
        });
        const waitMs = asInt(args.waitMs) ?? 0;
        if (waitMs > 0) {
          const settled = await waitForBackgroundJob(job.id, waitMs);
          if (settled && settled.status !== "running") {
            return result(jobReport(settled, {}, "(no output)"));
          }
          // Patience ran out while the job still runs. Said as an instruction, not
          // as news: told only that a note comes, the model fills the gap with
          // `sleep` (measured), and the sleep is the wait it was trying to avoid.
          return result(
            [
              `${job.id} is still running after ${patienceText(waitMs)} — ` +
                "it outlived the wait, it was not killed.",
              `Do not sleep and do not poll: stay with it by calling ${bgMcpToolName("job")}` +
                `({ jobId: "${job.id}", timeoutMs: ${MAX_WAIT_MS} }), or end your turn — ` +
                "the note with its output tail continues from there.",
              // A read comes back at once: it is not a second way to wait, and
              // naming it without saying so invites a poll loop.
              `To look at the output as it stands (this does not wait): ` +
                `${bgMcpToolName("job")}({ jobId: "${job.id}" }); ` +
                `to kill it: ${bgMcpToolName("job")}({ jobId: "${job.id}", kill: true }).`,
            ].join("\n"),
          );
        }
        return result(
          [
            `Started background job ${job.id} (${job.label}) in ${job.cwd}.`,
            `Output goes to ${job.logPath} — read it with read (windows) or grep.`,
            "It keeps running while you work; when it finishes the chat receives a note with its output tail.",
            `Read its output now with ${bgMcpToolName("job")}({ jobId: "${job.id}" }); ` +
              `kill it with ${bgMcpToolName("job")}({ jobId: "${job.id}", kill: true }).`,
          ].join("\n"),
        );
      }
      case "job": {
        const jobId = asString(args.jobId).trim();
        if (!jobId) {
          const jobs = listBackgroundJobs().filter((job) => job.sessionId === sessionId);
          if (!jobs.length) {
            return result(
              `This chat has no background jobs. Start one with ${bgMcpToolName("run")}({ command: "…" }).`,
            );
          }
          return result(["Background jobs of this chat:", ...jobs.map(jobLine)].join("\n"));
        }
        const job = ownedJob(jobId, sessionId);
        if (!job) return result(`Unknown job "${jobId}" in this chat.`, true);
        if (args.kill === true) {
          if (job.status !== "running") {
            return result(`${job.id} is not running any more (${job.status}).`);
          }
          stopBackgroundJob(job.id, "agent");
          return result(`${job.id} is stopping — its process tree is being killed.`);
        }
        // `timeoutMs` is patience, not a sleep: the call comes back the moment
        // the job ends, and a job that outlives it is simply still running.
        const patience = Math.min(Math.max(asInt(args.timeoutMs) ?? 0, 0), MAX_WAIT_MS);
        const current = patience > 0 ? await waitForBackgroundJob(jobId, patience) : job;
        const report = jobReport(current ?? job, args);
        if ((current ?? job).status !== "running") return result(report);
        return result(
          [
            report,
            patience > 0
              ? `Still running after ${patienceText(patience)} — nothing was killed. ` +
                `Call ${bgMcpToolName("job")}({ jobId: "${job.id}", timeoutMs: ${MAX_WAIT_MS} }) ` +
                "again to stay with it, or end your turn: the note with its tail arrives when it finishes."
              : `Still running. Call ${bgMcpToolName("job")}({ jobId: "${job.id}", timeoutMs: ${MAX_WAIT_MS} }) ` +
                "to stay with it — this read does not wait.",
          ].join("\n"),
        );
      }
      default:
        return result(`Tool "${String(name)}" is not implemented.`, true);
    }
  } catch (err) {
    return result(err instanceof Error ? err.message : String(err), true);
  }
}

const TOOLS: Array<ServedMcpTool & { name: BgMcpTool }> = TOOL_DEFS.map((def) => ({
  ...def,
  call: (args, ctx) => callTool(def.name, args, ctx.sessionId),
}));

/** Serve one MCP request for the chat named in the endpoint's query. */
export function handleBackgroundMcpRequest(
  payload: unknown,
  sessionId: string,
): Promise<ServedMcpResponse> {
  return handleServedMcpRequest(payload, { name: BG_MCP_SERVER_NAME, tools: TOOLS }, { sessionId });
}
