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

/**
 * The MCP server acpio is for its own chats: `run` starts a shell command in
 * the background, `list` / `output` / `stop` manage the ones this chat started.
 *
 * It is spoken over HTTP (see `POST /mcp/bg` in routes.ts) because every
 * harness acpio drives already knows how to talk to an HTTP MCP server — the
 * built-in agent has its own client in `@acpio/adapter-builtin`, omp and cursor
 * take the same `session/new` entry — so one endpoint serves them all, and no
 * harness needs code of its own.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "0.1.0";

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

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
const TOOLS: ToolDef[] = [
  {
    name: "run",
    readOnly: false,
    description:
      "Run a shell command in the background (builds, tests, dev servers) and return its job id at once. The chat gets its output tail when it finishes.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command line (bash, or cmd.exe on Windows)." },
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

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
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
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    const names = TOOLS.map((t) => t.name).join(", ");
    return textResult(`Unknown tool "${name}". Available tools: ${names}.`, true);
  }

  try {
    switch (tool.name) {
      case "run": {
        const command = asString(args.command).trim();
        if (!command) return textResult("`command` is required.", true);
        const session = (await listSessionsByIds([sessionId]))[0];
        if (!session) return textResult("This chat no longer exists.", true);
        const cwdArg = asString(args.cwd).trim();
        const cwd = cwdArg ? path.resolve(session.cwd || process.cwd(), cwdArg) : session.cwd;
        const job = await startBackgroundJob({
          sessionId,
          cwd: cwd || process.cwd(),
          script: command,
          label: asString(args.label),
        });
        return textResult(
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
          return textResult(
            `This chat has no background jobs. Start one with ${bgMcpToolName("run")}({ command: "…" }).`,
          );
        }
        return textResult(["Background jobs of this chat:", ...jobs.map(jobLine)].join("\n"));
      }
      case "output": {
        const jobId = asString(args.jobId).trim();
        if (!jobId) return textResult("`jobId` is required.", true);
        if (!ownedJob(jobId, sessionId)) return textResult(`Unknown job "${jobId}" in this chat.`, true);
        const read = readBackgroundJobOutput(jobId, {
          tailLines: asInt(args.tailLines) ?? DEFAULT_OUTPUT_TAIL_LINES,
          since: asInt(args.since),
          maxChars: DEFAULT_OUTPUT_MAX_CHARS,
        });
        if (!read) return textResult(`Unknown job "${jobId}" in this chat.`, true);
        const { job, text, to, dropped } = read;
        const exit = job.exitCode == null ? "" : ` exit ${job.exitCode}`;
        const body = text.trim() ? text.replace(/\s+$/, "") : "(no output yet)";
        return textResult(
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
        if (!jobId) return textResult("`jobId` is required.", true);
        const job = ownedJob(jobId, sessionId);
        if (!job) return textResult(`Unknown job "${jobId}" in this chat.`, true);
        if (job.status !== "running") {
          return textResult(`${job.id} is not running any more (${job.status}).`);
        }
        stopBackgroundJob(job.id, "agent");
        return textResult(`${job.id} is stopping — its process tree is being killed.`);
      }
      default:
        return textResult(`Tool "${name}" is not implemented.`, true);
    }
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err), true);
  }
}

function ok(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** One JSON-RPC frame in, one answer (or none, for a notification) out. */
async function handleMessage(message: JsonRpcMessage, sessionId: string): Promise<unknown | null> {
  const method = typeof message.method === "string" ? message.method : "";
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: BG_MCP_SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "ping") return isNotification ? null : ok(id, {});
  if (method.startsWith("notifications/")) return null;
  if (method === "tools/list") {
    return ok(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // Only the read-only hint is sent: a client treats an absent one as
        // "not read-only", and the built-in agent's plan mode reads exactly
        // this field.
        ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      })),
    });
  }
  if (method === "tools/call") {
    const params = message.params ?? {};
    const name = asString(params.name).trim();
    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    if (!name) return fail(id, -32602, "tools/call requires a tool name");
    return ok(id, await callTool(name, args, sessionId));
  }
  if (!method) return fail(id, -32600, "Missing method");
  return fail(id, -32601, `Unsupported method: ${method}`);
}

export interface BackgroundMcpResponse {
  /** HTTP status the route answers with. */
  status: number;
  /** JSON body, or null for a notification (answered with an empty 202). */
  body: unknown;
}

/** Serve one MCP request for the chat named in the endpoint's query. */
export async function handleBackgroundMcpRequest(
  payload: unknown,
  sessionId: string,
): Promise<BackgroundMcpResponse> {
  if (Array.isArray(payload)) {
    const answers: unknown[] = [];
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const answer = await handleMessage(item as JsonRpcMessage, sessionId);
      if (answer) answers.push(answer);
    }
    return answers.length ? { status: 200, body: answers } : { status: 202, body: null };
  }
  if (!payload || typeof payload !== "object") {
    return { status: 200, body: fail(null, -32700, "Parse error: expected a JSON-RPC object") };
  }
  const answer = await handleMessage(payload as JsonRpcMessage, sessionId);
  return answer ? { status: 200, body: answer } : { status: 202, body: null };
}
