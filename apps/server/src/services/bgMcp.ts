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
  readBackgroundJobOutput,
  startBackgroundJob,
  stopBackgroundJob,
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
 * the background, `list` / `output` / `stop` manage the ones this chat started.
 * The JSON-RPC plumbing it answers with lives in `servedMcp.ts`, shared with
 * the endpoint plugins get.
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
// name. The tool names, the note a settled job delivers and every result name
// the tools that read more, so the list itself does not have to.
const TOOL_DEFS: ToolDef[] = [
  {
    name: "run",
    readOnly: false,
    description:
      "Run a shell command in the background (builds, tests, dev servers) and return its job id at once. The chat gets its output tail when it finishes.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Shell command line, run through the same shell as the `bash` tool (on Windows Git Bash: `./x` for a " +
            "relative path, `//c` for a native CLI flag).",
        },
        label: { type: "string", description: "Short name shown in the UI." },
        cwd: { type: "string", description: "Working folder, relative to the chat folder." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "list",
    readOnly: true,
    description: "List this chat's background jobs, running first.",
    inputSchema: { type: "object" },
  },
  {
    name: "output",
    readOnly: true,
    description:
      "Read a job's output — the last lines, or only what is new since a previous read.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job id." },
        tailLines: { type: "integer", description: `Lines from the end (default ${DEFAULT_OUTPUT_TAIL_LINES}).` },
        since: { type: "integer", description: "Offset from a previous read — its `to` value." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "stop",
    readOnly: false,
    description: "Stop a job and its process tree.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", description: "Job id." } },
      required: ["jobId"],
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

/** A job id from another chat is "unknown" here on purpose: one chat never reads another's output. */
function ownedJob(jobId: string, sessionId: string): BackgroundJobDto | null {
  const job = getBackgroundJob(jobId);
  if (!job || job.sessionId !== sessionId) return null;
  return job;
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
        return result(
          [
            `Started background job ${job.id} (${job.label}) in ${job.cwd}.`,
            `Output goes to ${job.logPath} — read it with read (windows) or grep.`,
            "It keeps running while you work; when it finishes the chat receives a note with its output tail.",
            `Read its output now with ${bgMcpToolName("output")}({ jobId: "${job.id}" }); kill it with ${bgMcpToolName("stop")}({ jobId: "${job.id}" }).`,
          ].join("\n"),
        );
      }
      case "list": {
        const jobs = listBackgroundJobs().filter((job) => job.sessionId === sessionId);
        if (!jobs.length) {
          return result(
            `This chat has no background jobs. Start one with ${bgMcpToolName("run")}({ command: "…" }).`,
          );
        }
        return result(["Background jobs of this chat:", ...jobs.map(jobLine)].join("\n"));
      }
      case "output": {
        const jobId = asString(args.jobId).trim();
        if (!jobId) return result("`jobId` is required.", true);
        if (!ownedJob(jobId, sessionId)) return result(`Unknown job "${jobId}" in this chat.`, true);
        const read = readBackgroundJobOutput(jobId, {
          tailLines: asInt(args.tailLines) ?? DEFAULT_OUTPUT_TAIL_LINES,
          since: asInt(args.since),
          maxChars: DEFAULT_OUTPUT_MAX_CHARS,
        });
        if (!read) return result(`Unknown job "${jobId}" in this chat.`, true);
        const { job, text, to, dropped } = read;
        const exit = job.exitCode == null ? "" : ` exit ${job.exitCode}`;
        const body = text.trim() ? text.replace(/\s+$/, "") : "(no output yet)";
        return result(
          [
            `${job.id} [${job.status}${exit}] ${elapsedText(job)} — «${job.label}»`,
            `Log: ${job.logPath}`,
            dropped ? "(not the whole log — read the file for the rest)" : "",
            `--- output (to=${to}) ---`,
            body,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      case "stop": {
        const jobId = asString(args.jobId).trim();
        if (!jobId) return result("`jobId` is required.", true);
        const job = ownedJob(jobId, sessionId);
        if (!job) return result(`Unknown job "${jobId}" in this chat.`, true);
        if (job.status !== "running") {
          return result(`${job.id} is not running any more (${job.status}).`);
        }
        stopBackgroundJob(job.id, "agent");
        return result(`${job.id} is stopping — its process tree is being killed.`);
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
