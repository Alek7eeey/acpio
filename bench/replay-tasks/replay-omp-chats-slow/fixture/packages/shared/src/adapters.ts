/**
 * Harness adapter contract: the core (server + web) is harness-agnostic and
 * only knows the adapter registry. Each harness (Cursor, OMP, or a third-party
 * ACP-speaking agent) ships a package implementing {@link HarnessAdapter}.
 *
 * Adapters are static (compile-time registry) — the core imports the two
 * built-ins and third parties add their own packages to the registry.
 */

import type { AppSettings } from "./index.js";

/** Provider id — built-ins plus any registered adapter id. */
export type AgentProvider = "cursor" | "omp" | (string & {});

/** Terminal-only chat: no ACP agent, interactive shell in the session folder. */
export const SHELL_SESSION_PROVIDER = "shell" as const;

export function isShellSession(provider: string | null | undefined): boolean {
  return provider === SHELL_SESSION_PROVIDER;
}

export type AgentMode = "agent" | "plan" | "ask";

export interface AgentModeOption {
  value: string;
  name: string;
}

/**
 * One agent model catalog entry. `provider` is the upstream provider key the
 * harness reports (e.g. `zai` for `zai/glm-5.2`); absent when unknown.
 */
export type ModelOption = { value: string; name: string; provider?: string };

/** How an existing agent session is restored at boot. */
export type AdapterRestoreMode = "resume" | "load" | "new";

/**
 * A user-defined ACP agent (Settings → Connect → Custom agents). The core turns
 * each spec into a {@link HarnessAdapter} at runtime, so no code knows the
 * vendor: the user supplies the executable and its args.
 */
export interface CustomAgentSpec {
  /** Slug used as the provider id in sessions/settings. */
  id: string;
  /** Display label shown in pickers and settings. */
  label: string;
  /** Executable path or bare command name. */
  command: string;
  args: string[];
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** Windows-only: extra dirs under %LOCALAPPDATA% searched for `command`. */
  binaryDirs?: string[];
  restoreMode?: AdapterRestoreMode;
  suppressReplayOnLoad?: boolean;
  parameterizedModelPicker?: boolean;
  subagentStreaming?: boolean;
  cloudCatalog?: boolean;
}

/** Upper bound on user-defined agents — keeps the registry and UI sane. */
export const CUSTOM_AGENT_MAX = 20;

/** Legal provider id for a custom agent: lowercase slug, 1–32 chars. */
export const CUSTOM_AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Generic install hint: the core cannot know where a user's binary lives. */
const CUSTOM_AGENT_INSTALL_HINT =
  'Команда "{command}" не найдена. Укажите полный путь к исполняемому файлу ACP-агента.';

/** Fold free text from the id field into a legal slug. */
export function normalizeCustomAgentId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function normalizeEnvRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 32) break;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw !== "string") continue;
    out[key] = raw.slice(0, 2048);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Drop everything malformed and return concrete specs: unknown/duplicate ids
 * and missing commands are skipped, optionals get their defaults. Called by the
 * server before the registry is rebuilt, so a hand-edited settings row can
 * never register a broken agent.
 */
export function normalizeCustomAgents(
  raw: unknown,
  reserved: readonly string[] = [],
): CustomAgentSpec[] {
  if (!Array.isArray(raw)) return [];
  const taken = new Set(reserved);
  const out: CustomAgentSpec[] = [];
  for (const entry of raw) {
    if (out.length >= CUSTOM_AGENT_MAX) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const spec = entry as Record<string, unknown>;
    const id = normalizeCustomAgentId(spec.id);
    if (!CUSTOM_AGENT_ID_RE.test(id) || taken.has(id)) continue;
    const command = typeof spec.command === "string" ? spec.command.trim().slice(0, 512) : "";
    if (!command) continue;
    const label =
      (typeof spec.label === "string" ? spec.label.trim() : "").slice(0, 80) || id;
    const args = Array.isArray(spec.args)
      ? spec.args
          .filter((a): a is string => typeof a === "string" && a.trim() !== "")
          .map((a) => a.slice(0, 512))
          .slice(0, 64)
      : [];
    const binaryDirs = Array.isArray(spec.binaryDirs)
      ? spec.binaryDirs
          .filter((d): d is string => typeof d === "string" && d.trim() !== "")
          .map((d) => d.trim().replace(/[\\/]+/g, "").slice(0, 64))
          .slice(0, 8)
      : [];
    const env = normalizeEnvRecord(spec.env);
    const restoreMode: AdapterRestoreMode =
      spec.restoreMode === "load" || spec.restoreMode === "new" ? spec.restoreMode : "resume";
    taken.add(id);
    out.push({
      id,
      label,
      command,
      args,
      ...(env ? { env } : {}),
      ...(binaryDirs.length ? { binaryDirs } : {}),
      restoreMode,
      suppressReplayOnLoad: spec.suppressReplayOnLoad === true,
      parameterizedModelPicker: spec.parameterizedModelPicker !== false,
      subagentStreaming: spec.subagentStreaming === true,
      cloudCatalog: spec.cloudCatalog === true,
    });
  }
  return out;
}

/**
 * Build the runtime adapter for a normalized custom spec. Command/args live in
 * the spec (empty settings fields), so `adapterCommand`/`adapterArgs` fall back
 * to `defaultCommand`/`defaultArgs`.
 */
export function customAgentAdapter(spec: CustomAgentSpec): HarnessAdapter {
  return {
    id: spec.id,
    label: spec.label,
    custom: true,
    commandField: "",
    argsField: "",
    defaultCommand: spec.command,
    defaultArgs: [...spec.args],
    binaryNames: [],
    binaryDirs: [...(spec.binaryDirs ?? [])],
    ...(spec.env ? { env: { ...spec.env } } : {}),
    installHint: CUSTOM_AGENT_INSTALL_HINT,
    restoreMode: spec.restoreMode ?? "resume",
    suppressReplayOnLoad: spec.suppressReplayOnLoad ?? false,
    parameterizedModelPicker: spec.parameterizedModelPicker ?? true,
    subagentStreaming: spec.subagentStreaming ?? false,
    cloudCatalog: spec.cloudCatalog ?? false,
    defaultModes: [],
    subagentToolKinds: [],
    requestKinds: {
      "session/request_permission": "permission",
      "session/ask_question": "ask_question",
    },
    extensionKinds: {},
  };
}

/**
 * Normalized core event kinds produced from harness-specific extension
 * methods. The core switches on the kind, never on raw method names.
 */
export type AdapterExtensionKind =
  | "todos" // agent updates its todo list
  | "subagent_task" // nested agent started/updated (one card)
  | "subagent_roster" // full subagent snapshot (cards upserted per agent id)
  | "subagent_progress" // one subagent work update
  | "image"; // image generation result

/** A normalized upsert directive for a subagent card. */
export interface SubagentCardUpdate {
  agentId: string;
  parentId?: string;
  status: "running" | "completed" | "failed";
  title: string;
  description?: string;
  body?: string;
  /** Nested tool calls observed while the subagent runs (OMP progress / Cursor transcript). */
  tools?: SubagentToolEvent[];
  subagentType?: string;
  metrics?: Record<string, unknown>;
  resolvedModel?: string;
  raw: Record<string, unknown>;
}

/** One nested tool invocation inside a subagent card. */
export interface SubagentToolEvent {
  name: string;
  args?: string;
  status?: "running" | "completed" | "failed";
}

/** A normalized live-work update for an existing subagent card. */
export interface SubagentProgressUpdate {
  agentId: string;
  status: "running" | "completed" | "failed";
  title: string;
  description?: string;
  body?: string;
  tools?: SubagentToolEvent[];
  metrics?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** Minimal client surface adapters use to read a subagent transcript. */
export interface AdapterTranscriptClient {
  requestAgent<T>(method: string, params: Record<string, unknown>): Promise<T>;
  /** Workspace cwd — Cursor resolves `agent-transcripts` under `~/.cursor/projects`. */
  cwd?: string;
  /** Cursor ACP session id — joins to `~/.cursor/acp-sessions/<id>/store.db`. */
  acpSessionId?: string;
}

export interface SubagentTranscriptPage {
  fromByte?: number;
  nextByte?: number;
  reset?: boolean;
  messages?: Array<{ role?: string; content?: unknown[] }>;
}

/**
 * Options handed to an in-process agent when its transport is created.
 * `stateDir` is where the agent keeps state the core cannot reconstruct for it
 * (its own conversation history, for `session/load`).
 */
export interface InProcessAgentOptions {
  settings: AppSettings;
  /** Session workspace — agent tools run against this directory. */
  cwd: string;
  /** Session mode at boot (agent/plan/ask). */
  mode: AgentMode;
  /** Per-install directory for the agent's own state. */
  stateDir: string;
}

/**
 * An in-process agent speaking ACP over an in-memory line transport: the same
 * JSON-RPC frames a spawned CLI would put on stdio, without the process.
 *
 * Delivery is asynchronous on BOTH sides — the client registers a pending
 * request only after writing it, so an agent answering inline would be dropped.
 */
export interface InProcessAgentTransport {
  /** JSON-RPC line from the ACP client into the agent. */
  write(line: string): void;
  /** JSON-RPC lines the agent emits (updates, requests to the client, replies). */
  onLine(cb: (line: string) => void): void;
  /** The agent stopped — a fatal error, or the result of `close()`. */
  onClose(cb: (info?: { message?: string }) => void): void;
  /** Dispose: abort the running turn and release resources. */
  close(): void;
}

/**
 * Everything the core needs to know about a harness. Declarative data plus a
 * few behavior hooks; adapters depend only on `@acpio/shared`.
 */
export interface HarnessAdapter {
  /** Provider id stored in sessions/settings ("cursor", "omp", …). */
  id: AgentProvider;
  /** Display label ("Cursor", "OMP"). */
  label: string;
  /** i18n key for the settings description (built-in harnesses only). */
  descriptionKey?: string;
  /** Literal settings description (user-defined agents, no i18n key). */
  description?: string;
  /** True for user-defined agents from Settings → Connect. */
  custom?: boolean;

  // ── CLI & config ─────────────────────────────────────────────────────────
  /** Settings field holding the executable command ("" for custom agents). */
  commandField: string;
  /** Settings field holding the CLI args array ("" for custom agents). */
  argsField: string;
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** Optional settings field holding an API key. */
  apiKeyField?: string;
  /** Env var the API key is exported as (e.g. CURSOR_API_KEY). */
  envApiKeyName?: string;
  defaultCommand: string;
  defaultArgs: string[];
  /** Binary names `resolveCommand` tries on Windows. */
  binaryNames: string[];
  /** Extra PATH dirs appended when spawning. */
  binaryDirs: string[];
  /** Human-readable install instructions shown when the command is missing. */
  installHint: string;
  /**
   * In-process agent: builds the ACP endpoint instead of spawning a CLI, so
   * `defaultCommand`/`binaryNames`/`installHint` are never consulted. Absent =
   * the harness runs as a child process.
   */
  createTransport?: (opts: InProcessAgentOptions) => InProcessAgentTransport;

  // ── Session lifecycle ────────────────────────────────────────────────────
  /** How a stored agent session is restored (new = never restore). */
  restoreMode: AdapterRestoreMode;
  /** True when session/load replays history that the core already stores. */
  suppressReplayOnLoad: boolean;
  /** ACP `authenticate` method id sent at boot (e.g. "cursor_login"). */
  authenticateMethodId?: string;

  // ── Capabilities ─────────────────────────────────────────────────────────
  /** Agent exposes model params as separate config options (fast/effort/…). */
  parameterizedModelPicker: boolean;
  /** Agent streams subagent transcripts (live thinking into cards). */
  subagentStreaming: boolean;
  /** Models come from the CLI `models --json` catalog (cloud-backed). */
  cloudCatalog: boolean;
  /** Modes offered when the agent omits its own list. */
  defaultModes: AgentModeOption[];
  /** ACP tool `kind` values that denote nested agents. */
  subagentToolKinds: readonly string[];

  // ── Extension methods ────────────────────────────────────────────────────
  /** Raw ACP request method → normalized core request kind. */
  requestKinds: Record<string, "permission" | "ask_question" | "create_plan">;
  /**
   * Map a permission-shaped ACP request to an ask_question payload for the UI.
   * Return null to keep the default permission card (allow/deny).
   */
  coercePermissionToQuestion?: (
    params: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  /** Raw ACP method → normalized core kind. */
  extensionKinds: Record<string, AdapterExtensionKind>;
  /** Reply envelope for extension requests (undefined → notification). */
  extensionReply?: (method: string, params: Record<string, unknown>) => unknown;
  /** Map a roster entry to a normalized card update (null → skip). */
  subagentCardFromRoster?: (entry: Record<string, unknown>) => SubagentCardUpdate | null;
  /** Map a progress entry to a normalized card update. */
  subagentCardFromProgress?: (
    entry: Record<string, unknown>,
  ) => SubagentProgressUpdate | null;
  /** Map a "subagent task" request to a card (plus an optional toolCallId for
   *  dedup with the parallel ACP tool_call part). */
  subagentTaskCard?: (
    params: Record<string, unknown>,
  ) => { toolCallId?: string; card: SubagentCardUpdate } | null;
  /** Read one incremental page of a subagent transcript. */
  readSubagentTranscript?: (
    client: AdapterTranscriptClient,
    agentId: string,
    fromByte: number,
  ) => Promise<SubagentTranscriptPage | undefined>;

  // ── Availability ─────────────────────────────────────────────────────────
  /**
   * Cheap pre-boot check: a user-facing reason the harness cannot run yet
   * (endpoint not configured), or null when it can. Absent = always try the
   * real boot; a failed boot reports availability false anyway. Used by the
   * probe so "online" never means merely "the process started".
   */
  unavailableReason?: (settings: AppSettings) => string | null;

  // ── Model catalog ────────────────────────────────────────────────────────
  /** Broader catalog than the ACP option list (CLI `models --json`). */
  probeModels?: (ctx: AdapterProbeContext) => Promise<ModelOption[] | null>;
}

/** Context the core provides to {@link HarnessAdapter.probeModels}. */
export interface AdapterProbeContext {
  settings: AppSettings;
  /** Run the adapter's CLI with the given args; returns stdout. */
  runCli(args: string[]): Promise<string>;
}

/** Static registry: every harness the core knows about. */
export interface AdapterRegistry {
  get(id: string): HarnessAdapter | undefined;
  list(): HarnessAdapter[];
  ids(): string[];
}

/** Adapter metadata as served to the web (`/api/adapters`). */
export interface AdapterMetaDto {
  id: string;
  label: string;
  /** False when the harness is switched off in Settings → Connect. */
  enabled: boolean;
  /** i18n key for the description (built-in harnesses only). */
  descriptionKey?: string;
  /** Literal description (user-defined agents). */
  description?: string;
  /** True for user-defined agents — their fields live in `customAgents`. */
  custom?: boolean;
  commandField: string;
  argsField: string;
  apiKeyField?: string;
  envApiKeyName?: string;
  defaultCommand: string;
  defaultArgs: string[];
  installHint: string;
  restoreMode: AdapterRestoreMode;
  parameterizedModelPicker: boolean;
  subagentStreaming: boolean;
  cloudCatalog: boolean;
  defaultModes: AgentModeOption[];
  subagentToolKinds: string[];
}
