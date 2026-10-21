/**
 * Plugin contracts for acpio — types only, deliberately no runtime code.
 *
 * A plugin is an ESM bundle whose default export is a
 * {@link PluginBundle}: the host calls it once at boot with a
 * {@link PluginRegistrationContext} and keeps the extension points it returns.
 *
 * Rules the host enforces (so a plugin need not):
 *  - the registry is immutable after boot — a new plugin version applies after a
 *    server restart, never in a running process;
 *  - tool results are clipped and tool calls are timed out by the host, and a
 *    failing handler becomes an `isError` result instead of a broken session;
 *  - a plugin never sees a session: permissions for a tool call are asked by the
 *    harness that calls it, exactly as for any other MCP server.
 */

/** One JSON object, the shape of a plugin's own configuration. */
export type JsonObject = Record<string, unknown>;

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/**
 * What a plugin bundle's default export returns: its identity plus every
 * extension point it contributes, in the order the host should apply them.
 */
export interface PluginDefinition {
  /** Same id as in the manifest entry that points at this bundle. */
  id: string;
  extensions: AcpPluginExtensionPoint[];
}

/**
 * One entry of the host's flat extension-point registry. A consumer takes what
 * it understands and ignores the rest — `extensions.select(x => x.mcpServer)`.
 */
export interface AcpPluginExtensionPoint {
  mcpServer?: McpServerContribution | McpServerContribution[];
  modelProvider?: ModelProviderContribution | ModelProviderContribution[];
  skillPath?: string | SkillFolderContribution | Array<string | SkillFolderContribution>;
}

export interface PluginRegistrationContext {
  /** The manifest entry's `config` object, as written. */
  config: JsonObject;
  /** Directory of the loaded bundle: `data/plugins/<id>/<version>-<hash>/`. */
  home: string;
  log: PluginLogger;
}

/** Default export of a plugin bundle. */
export type PluginBundle = (
  context: PluginRegistrationContext,
) => PluginDefinition | Promise<PluginDefinition>;

// ── MCP servers ─────────────────────────────────────────────────────────────
//
// The host exposes every contributed server as a real MCP endpoint over HTTP
// and hands it to the harness over ACP, so the tools of a plugin reach the
// built-in agent, Cursor, OMP and opencode alike.

export interface McpServerContribution {
  /** Short id inside the plugin; the host keys it as `<pluginId>:<serverId>`. */
  id: string;
  /** Name for the settings list. */
  label: string;
  description?: string;
  /**
   * Free-form JSON config — credentials and anything else the server needs.
   * Merged as `defaults` ← the manifest entry's `config.mcp[serverId]` ← the
   * user's own edits in Settings, so a shipped default never blocks an edit and
   * an edit never blocks a new default.
   */
  config?: { defaults?: JsonObject; sample?: JsonObject };
  /** `false` → the server shows as "not configured" and is not attached. */
  isConfigured?(config: JsonObject): boolean;
  create(context: McpServerContext): PluginMcpServer | Promise<PluginMcpServer>;
}

export interface McpServerContext {
  /** The merged config described on {@link McpServerContribution.config}. */
  config: JsonObject;
  log: PluginLogger;
  plugin: { id: string; version: string; home: string };
}

export interface PluginMcpServer {
  /** Tools by id. The model calls them as `mcp__<serverId>_<toolId>`. */
  tools: Record<string, PluginTool>;
}

export interface PluginTool {
  description: string;
  /** JSON Schema published as the tool's `inputSchema`. */
  schema: unknown;
  /** `true` → `annotations.readOnlyHint`; read-only tools are also offered in modes whose agent may not act. */
  readOnly?: boolean;
  handler(input: unknown): Promise<string | { text: string; isError?: boolean }>;
}

// ── Skills ──────────────────────────────────────────────────────────────────
//
// A skill is a folder holding a `SKILL.md` — the same thing Settings → Skill
// folders points the agent at. A plugin contributes the folders it keeps its
// own in (`<dir>/<name>/SKILL.md`), and the host scans them exactly like a
// user's: the model applies one by reading its SKILL.md with the `read` tool,
// the settings list offers the mode switch, and nothing about a skill is code.

/**
 * One folder of skills. `supersedes` is the only thing a SKILL.md cannot say
 * itself, and it is the plugin's to declare — the skill text stays exactly as
 * its author wrote it, including when it is a third-party skill shipped as-is.
 */
export interface SkillFolderContribution {
  /** Folder holding `<name>/SKILL.md`, relative to the plugin's own directory. */
  path: string;
  /**
   * Ids of the harness's base rules (agent.ts's `RULES`) that a skill of this
   * folder words itself, keyed by skill name. Honoured only while that skill is
   * `active` (in effect from the chat's first turn), because only then is its
   * body in the same prompt as the rules it stands in for.
   */
  supersedes?: Record<string, string[]>;
}

// ── Model providers ─────────────────────────────────────────────────────────
//
// A provider the built-in agent may talk to: the plugin ships the endpoint and
// the recommended models, the user only pastes an API key. Models the plugin
// recommends arrive in the picker enabled; edits and hand-added models of the
// user survive a plugin update.

export interface ModelProviderContribution {
  /** Short id inside the plugin; the host keys it as `<pluginId>:<providerId>`. */
  id: string;
  label: string;
  description?: string;
  /** OpenAI-compatible base URL (the host appends `/models` when probing). */
  baseUrl: string;
  /** Where the user gets a key — shown next to the key field. */
  apiKeyHint?: string;
  /**
   * Whether the endpoint answers without a key. Default `false`: the provider
   * stays out of the model pickers until the user pastes one — which is the
   * whole point of shipping the endpoint from a plugin.
   */
  apiKeyOptional?: boolean;
  /** Extra headers sent with every request; `{{sessionId}}` is filled by the host. */
  headers?: Array<{ name: string; value: string }>;
  /** Recommended models, added to the picker as-is. */
  models: Array<{
    /** Wire id sent to the endpoint. */
    id: string;
    label: string;
    /** Context window in tokens — drives the context chip and history pruning. */
    contextWindow: number;
    enabled?: boolean;
  }>;
  /** Extra JSON merged into every request body (provider-specific knobs). */
  body?: string;
}
