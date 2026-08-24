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

export type AgentMode = "agent" | "plan" | "ask";

export interface AgentModeOption {
  value: string;
  name: string;
}

export type ModelOption = { value: string; name: string };

/** How an existing agent session is restored at boot. */
export type AdapterRestoreMode = "resume" | "load" | "new";

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
 * Everything the core needs to know about a harness. Declarative data plus a
 * few behavior hooks; adapters depend only on `@acprocess/shared`.
 */
export interface HarnessAdapter {
  /** Provider id stored in sessions/settings ("cursor", "omp", …). */
  id: AgentProvider;
  /** Display label ("Cursor", "OMP"). */
  label: string;
  /** i18n key for the settings description. */
  descriptionKey: string;

  // ── CLI & config ─────────────────────────────────────────────────────────
  /** Settings field holding the executable command. */
  commandField: string;
  /** Settings field holding the CLI args array. */
  argsField: string;
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
  descriptionKey: string;
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
