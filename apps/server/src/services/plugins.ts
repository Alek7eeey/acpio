/**
 * Plugin host: reads the config source (a URL or a local path), caches every
 * plugin bundle under `data/plugins/<id>/<version>-<hash>/` and loads its
 * extension points into one flat registry that consumers read on demand.
 *
 * The app's own plugins ({@link SHIPPED_PLUGINS}) are part of the build instead
 * of the source: they load last, so a manifest entry — and above all the user's
 * own row — with the same id wins over them, and switching one off is the same
 * `enabled: false` row as for any other.
 *
 * Read once, at boot: a new plugin version, or an edited source, applies after
 * the server is restarted — the registry never changes while the process lives.
 * A plugin that fails to read, download or import is reported in the state and
 * skipped; it never takes the boot down with it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  resolvePluginSource,
  resolveServerPort,
  type AppSettings,
  type PluginSkillFolder,
  type BuiltinModelConfig,
  type BuiltinProviderConfig,
  type McpServerConfig,
  type PluginEntryConfig,
  type PluginProviderOverride,
  type LoadedPluginDto,
  type PluginMcpServerDto,
  type PluginsStateDto,
  type ResolvedPluginSource,
} from "@acpio/shared";
import type {
  AcpPluginExtensionPoint,
  JsonObject,
  McpServerContribution,
  ModelProviderContribution,
  PluginDefinition,
  PluginLogger,
  PluginRegistrationContext,
  PluginTool,
  SkillFolderContribution,
} from "@acpio/plugin-api";
import { DATA_DIR } from "../db/client.js";
import { MCP_TOKEN } from "./mcpToken.js";
import {
  handleServedMcpRequest,
  type ServedMcpResponse,
  type ServedMcpTool,
} from "./servedMcp.js";
import { getSettings, setPluginProviderSource, setPluginSkillSource } from "./settings.js";

/** Plugin state lives beside the database: `<data dir>/plugins`
 *  (`ACPIO_PLUGINS_DIR` moves it, the way `DATABASE_PATH` moves the DB). */
export const PLUGINS_DIR = process.env.ACPIO_PLUGINS_DIR ?? path.join(DATA_DIR, "plugins");
/** Default source when the setting is empty — the folder to drop a config into. */
const DEFAULT_CONFIG_FILE = path.join(PLUGINS_DIR, "config.json");
/** Last manifest that parsed, used when the source cannot be read at boot. */
const MANIFEST_CACHE = path.join(PLUGINS_DIR, "manifest.json");
const FETCH_TIMEOUT_MS = 15_000;
const MANIFEST_MAX_CHARS = 1_000_000;
/** A tool result is clipped to this many characters, like the MCP client does. */
const RESULT_CLIP_CHARS = 30_000;
/** A plugin's tool call that outlives this answers with an error. */
const CALL_TIMEOUT_MS = 180_000;
/**
 * Plugins the app itself ships: the module is part of the build, so there is no
 * bundle to fetch or cache — only an id to name it and a version to report.
 */
const SHIPPED_PLUGINS: ReadonlyArray<{ id: string; version: string; module: string }> = [
  { id: "ponytail", version: "0.1.0", module: "@acpio/plugin-ponytail" },
];

/** Contribution ids double as endpoint path segments and tool-name parts. */
const CONTRIBUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A plugin id names a cache folder and rides every `plugin:<id>:…` id. */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const entrySchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE),
  version: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  server: z
    .union([z.string().min(1).max(2_000), z.object({ url: z.string().min(1).max(2_000) })])
    .optional(),
  /** The plugin's own config, handed to its bundle as-is. */
  config: z.record(z.unknown()).optional(),
});

const manifestSchema = z.object({
  schema: z.literal(1).optional(),
  plugins: z.array(z.unknown()),
});

const cacheSchema = z.object({ at: z.string(), source: z.string(), text: z.string() });

/** One manifest row, validated and with defaults applied. */
export interface PluginManifestEntry {
  id: string;
  version: string;
  enabled: boolean;
  /** `server` as written; resolved against the manifest when it is loaded. */
  server: string | null;
  config: Record<string, unknown>;
}

export interface ManifestRead {
  entries: PluginManifestEntry[];
  warnings: string[];
  /** ISO time of the cached manifest in use, when the source could not be read. */
  staleAt?: string;
}

/** One plugin as the settings page lists it (`LoadedPluginDto` in shared). */
export type LoadedPlugin = LoadedPluginDto;
/** Plugin host state served by `GET /api/plugins` (`PluginsStateDto` in shared). */
export type PluginsState = PluginsStateDto;

/** One MCP server a plugin contributes, with its merged config and its tools. */
export interface RegisteredPluginMcp {
  /** `<pluginId>:<serverId>` — the key of the contribution. */
  fullId: string;
  pluginId: string;
  serverId: string;
  /** Name the harness sees, unique per boot — tool names are built from it. */
  name: string;
  label: string;
  description?: string;
  configured: boolean;
  tools: ServedMcpTool[];
  error?: string;
}

/** Id the MCP switches use for a plugin server (`mcpBuiltinDisabledIds`). */
export function pluginMcpServerId(pluginId: string, serverId: string): string {
  return `plugin:${pluginId}:${serverId}`;
}

/** One model provider a plugin contributes, as the plugin declared it. */
export interface RegisteredPluginProvider {
  /** `<pluginId>:<providerId>` — the key of the user's own half. */
  fullId: string;
  pluginId: string;
  providerId: string;
  label: string;
  description?: string;
  baseUrl: string;
  apiKeyHint?: string;
  apiKeyOptional?: boolean;
  headers?: Array<{ name: string; value: string }>;
  body?: string;
  /** Recommended models; the user's edits are merged over them on read. */
  models: BuiltinModelConfig[];
}

/** Row id of a plugin's provider; the `plugin:` prefix keeps it out of the way. */
export function pluginProviderRowId(pluginId: string, providerId: string): string {
  return `plugin:${pluginId}:${providerId}`;
}

/** Recommended models first, then the user's edits and additions by model id. */
function mergeProviderModels(
  recommended: BuiltinModelConfig[],
  edits: BuiltinModelConfig[] | undefined,
): BuiltinModelConfig[] {
  const byId = new Map<string, BuiltinModelConfig>(
    recommended.map((model) => [model.id, { ...model, enabled: model.enabled ?? true }]),
  );
  for (const row of edits ?? []) {
    const known = byId.get(row.id);
    byId.set(row.id, known ? { ...known, ...row } : row);
  }
  return [...byId.values()];
}

/**
 * Plugin providers as ordinary provider rows, with the user's half merged in:
 * the endpoint, headers and recommended models come from the plugin, the key
 * (and any edit) from the settings. A provider shipped for a keyed service
 * stays `enabled: false` — and so out of every picker — until a key is there,
 * while the settings list still shows it, since that is where the key goes.
 */
export function pluginProviders(settings: AppSettings): BuiltinProviderConfig[] {
  return registry.providers.map((p) => {
    const user: PluginProviderOverride | undefined = settings.pluginProviders?.[p.fullId];
    const apiKey = user?.apiKey ?? "";
    return {
      id: pluginProviderRowId(p.pluginId, p.providerId),
      name: p.label,
      url: user?.urlOverride?.trim() || p.baseUrl,
      apiKey,
      enabled: user?.enabled ?? (p.apiKeyOptional === true || Boolean(apiKey)),
      models: mergeProviderModels(p.models, user?.models),
      ...(p.headers?.length ? { headers: p.headers } : {}),
      ...(p.body ? { body: p.body } : {}),
      pluginId: p.fullId,
      ...(p.apiKeyHint ? { apiKeyHint: p.apiKeyHint } : {}),
    };
  });
}

/**
 * Plugin servers as ordinary MCP configs, ready for `session/new`: the url
 * carries this boot's port and token, and the global switch is applied, so a
 * folder override or a chat's own list reaches them like any other server.
 */
export function pluginMcpServers(settings: AppSettings): McpServerConfig[] {
  const off = new Set(settings.mcpBuiltinDisabledIds ?? []);
  const port = resolveServerPort();
  return registry.mcpServers
    .filter((s) => s.configured && !s.error)
    .map((s) => {
      const id = pluginMcpServerId(s.pluginId, s.serverId);
      return {
        id,
        name: s.name,
        enabled: !off.has(id),
        type: "remote" as const,
        url: `http://127.0.0.1:${port}/api/mcp/plugin/${s.pluginId}/${s.serverId}?token=${MCP_TOKEN}`,
      };
    });
}

/** The server an endpoint call addresses, or undefined when it is not registered. */
export function findPluginMcpServer(
  pluginId: string,
  serverId: string,
): RegisteredPluginMcp | undefined {
  return registry.mcpServers.find((s) => s.pluginId === pluginId && s.serverId === serverId);
}
/**
 * Serve one MCP request with a plugin's tools. The clip and the call timeout
 * stay here rather than in the plugin: the host owns the context budget.
 */
export function handlePluginMcpRequest(
  payload: unknown,
  server: RegisteredPluginMcp,
): Promise<ServedMcpResponse> {
  return handleServedMcpRequest(
    payload,
    {
      name: server.name,
      tools: server.tools,
      clipChars: RESULT_CLIP_CHARS,
      timeoutMs: CALL_TIMEOUT_MS,
    },
    { sessionId: "" },
  );
}

const registry: {
  extensions: AcpPluginExtensionPoint[];
  plugins: LoadedPlugin[];
  mcpServers: RegisteredPluginMcp[];
  providers: RegisteredPluginProvider[];
  skillFolders: PluginSkillFolder[];
  warnings: string[];
  loadedAt: string | null;
  bootSourceLabel: string;
} = {
  extensions: [],
  plugins: [],
  mcpServers: [],
  providers: [],
  skillFolders: [],
  warnings: [],
  loadedAt: null,
  bootSourceLabel: "",
};

const log: PluginLogger = {
  info: (message) => console.log(`[plugin] ${message}`),
  warn: (message) => console.warn(`[plugin] ${message}`),
  error: (message, error) =>
    console.error(`[plugin] ${message}`, error instanceof Error ? error.message : (error ?? "")),
};

/** Skill folders the loaded plugins ship, absolute — what the agent scans. */
export function pluginSkillFolders(): PluginSkillFolder[] {
  return registry.skillFolders;
}

/** Every extension point of every loaded plugin, in registration order. */
export function extensions(): AcpPluginExtensionPoint[] {
  return registry.extensions;
}

/** What a consumer reads: `selectExtensions(x => x.mcpServer)`. */
export function selectExtensions<T>(map: (x: AcpPluginExtensionPoint) => T | undefined): T[] {
  return registry.extensions.map(map).filter((x): x is T => x !== undefined);
}

/** The source the settings point at right now, or null when it is unusable. */
export async function pluginSource(): Promise<ResolvedPluginSource | null> {
  return pluginSourceFrom(await getSettings());
}

/** The config source of a settings snapshot: the setting, or the default file. */
function pluginSourceFrom(settings: AppSettings): ResolvedPluginSource | null {
  try {
    return resolvePluginSource(settings.pluginsConfig, { cwd: process.cwd(), home: os.homedir() })
      ?? { kind: "path", path: DEFAULT_CONFIG_FILE };
  } catch {
    return null;
  }
}

/** Plugins added by hand, in the shape the manifest reader hands over. */
function ownPluginEntries(settings: AppSettings): PluginManifestEntry[] {
  return (settings.pluginEntries ?? []).map((row) => ({
    id: String(row.id ?? "").trim().toLowerCase(),
    version: row.version?.trim() || "0.0.0",
    enabled: row.enabled !== false,
    server: row.server?.trim() || null,
    config: row.config ?? {},
  }));
}

/**
 * What this boot's registry was built from: the config source plus the plugins
 * added by hand. A change to either one applies on the next server start.
 */
function sourceKey(label: string, entries: PluginEntryConfig[] | undefined): string {
  return entries?.length ? `${label} + ${JSON.stringify(entries)}` : label;
}

function sourceLabel(source: ResolvedPluginSource | null): string {
  if (!source) return "";
  return source.kind === "url" ? source.url : source.path;
}

/** What the settings page shows: the source, what loaded, and what waits for a restart. */
export async function pluginsState(): Promise<PluginsState> {
  const settings = await getSettings();
  const source = pluginSourceFrom(settings);
  const label = sourceLabel(source);
  return {
    source,
    sourceLabel: label,
    dir: PLUGINS_DIR,
    loadedAt: registry.loadedAt,
    pendingRestart: sourceKey(label, settings.pluginEntries) !== registry.bootSourceLabel,
    warnings: registry.warnings,
    plugins: registry.plugins,
    mcpServers: registry.mcpServers.map((s) => ({
      id: pluginMcpServerId(s.pluginId, s.serverId),
      name: s.name,
      label: s.label,
      pluginId: s.pluginId,
      serverId: s.serverId,
      configured: s.configured && !s.error,
      tools: s.tools.length,
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Read the manifest text: local file or URL, never cached by HTTP. */
async function readSourceText(source: ResolvedPluginSource): Promise<string> {
  if (source.kind === "path") {
    return stripBom(await fs.readFile(source.path, "utf8")).slice(0, MANIFEST_MAX_CHARS);
  }
  const res = await fetch(source.url, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return stripBom(await res.text()).slice(0, MANIFEST_MAX_CHARS);
}

/** Validate one manifest row; a bad row is a warning, not a dead manifest. */
function parseEntries(rows: unknown[]): { entries: PluginManifestEntry[]; warnings: string[] } {
  const entries: PluginManifestEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const parsed = entrySchema.safeParse(row);
    if (!parsed.success) {
      warnings.push(`plugins[${index}]: ${parsed.error.issues[0]?.message ?? "invalid entry"}`);
      return;
    }
    const { id, version, enabled, server, config } = parsed.data;
    if (seen.has(id)) {
      warnings.push(`plugins[${index}]: duplicate id "${id}"`);
      return;
    }
    seen.add(id);
    entries.push({
      id,
      version: version ?? "0.0.0",
      enabled: enabled ?? true,
      server: typeof server === "string" ? server : (server?.url ?? null),
      config: config ?? {},
    });
  });
  return { entries, warnings };
}

/**
 * Read and parse the manifest, falling back to the last one that parsed when
 * the source is unreachable — a dead host or an unmounted disk must not empty
 * the plugin list of a running install.
 */
export async function readManifest(source: ResolvedPluginSource): Promise<ManifestRead> {
  try {
    const text = await readSourceText(source);
    const parsed = manifestSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) {
      throw new Error(`invalid manifest: ${parsed.error.issues[0]?.message ?? "unknown shape"}`);
    }
    const { entries, warnings } = parseEntries(parsed.data.plugins);
    await writeManifestCache(text, sourceLabel(source));
    return { entries, warnings };
  } catch (err) {
    const cached = await readManifestCache(sourceLabel(source));
    if (!cached) throw err;
    const parsed = manifestSchema.safeParse(JSON.parse(cached.text) as unknown);
    if (!parsed.success) throw err;
    const { entries, warnings } = parseEntries(parsed.data.plugins);
    return {
      entries,
      warnings: [
        ...warnings,
        `source unavailable (${err instanceof Error ? err.message : String(err)}), using the cached manifest`,
      ],
      staleAt: cached.at,
    };
  }
}

async function writeManifestCache(text: string, source: string): Promise<void> {
  try {
    await fs.mkdir(PLUGINS_DIR, { recursive: true });
    await fs.writeFile(MANIFEST_CACHE, JSON.stringify({ at: new Date().toISOString(), source, text }));
  } catch (err) {
    log.warn(`could not cache the manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readManifestCache(source: string): Promise<{ at: string; text: string } | null> {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(await fs.readFile(MANIFEST_CACHE, "utf8")) as unknown);
    if (!parsed.success || parsed.data.source !== source) return null;
    return { at: parsed.data.at, text: parsed.data.text };
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readBundleBytes(source: ResolvedPluginSource): Promise<Buffer> {
  if (source.kind === "path") return fs.readFile(source.path);
  const res = await fetch(source.url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A version is a path segment: keep it boring, whatever the manifest says. */
function safeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 32) || "0.0.0";
}

/**
 * Copy (or download) a bundle into `data/plugins/<id>/<version>-<hash>/` and
 * return its file. The hash is of the content, so an author who changes the
 * code without bumping the version still gets a new directory — while a restart
 * with an unchanged bundle writes nothing at all.
 */
export async function cachePluginBundle(
  id: string,
  version: string,
  source: ResolvedPluginSource,
): Promise<string> {
  const bytes = await readBundleBytes(source);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const dir = path.join(PLUGINS_DIR, id, `${safeVersion(version)}-${hash}`);
  const file = path.join(dir, "server.js");
  if (await exists(file)) return file;
  const tmp = `${dir}.tmp-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, "server.js"), bytes);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await fs.rename(tmp, dir);
  } catch (err) {
    // Another boot won the race — the same content, so the same directory.
    await fs.rm(tmp, { recursive: true, force: true });
    if (!(await exists(file))) throw err;
  }
  return file;
}

/** Contributions may be written as one object or an array of them. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * `defaults` ← the manifest entry's `config.mcp[serverId]`. Credentials are the
 * usual case: they ride the manifest so a team can be provisioned with one URL.
 */
function mergeMcpConfig(
  contribution: McpServerContribution,
  entry: PluginManifestEntry,
  serverId: string,
): JsonObject {
  return {
    ...asObject(contribution.config?.defaults),
    ...asObject(asObject(entry.config.mcp)[serverId]),
  };
}

/** Names are unique per boot: two plugins must not claim the same one. */
function serverName(serverId: string): string {
  return serverId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Plugin tools as the MCP endpoint serves them. */
function toServedTools(tools: Record<string, PluginTool>, serverName_: string): ServedMcpTool[] {
  return Object.entries(tools ?? {}).map(([name, tool]) => ({
    name,
    description: tool.description ?? `${serverName_}: ${name}`,
    inputSchema: tool.schema ?? { type: "object", properties: {} },
    readOnly: tool.readOnly === true,
    call: async (args) => {
      const result = await tool.handler(args);
      return typeof result === "string"
        ? { text: result }
        : { text: result?.text ?? "", isError: result?.isError === true };
    },
  }));
}

/**
 * Create every MCP server one plugin contributes `create()` is where a plugin
 * builds its tools, so a throw here is that server's failure, never the boot's.
 */
async function registerMcpServers(
  entry: PluginManifestEntry,
  dir: string,
  points: AcpPluginExtensionPoint[],
  takenNames: Set<string>,
): Promise<RegisteredPluginMcp[]> {
  const out: RegisteredPluginMcp[] = [];
  for (const point of points) {
    for (const contribution of asArray(point.mcpServer)) {
      const serverId = contribution?.id ?? "";
      const base: RegisteredPluginMcp = {
        fullId: `${entry.id}:${serverId}`,
        pluginId: entry.id,
        serverId,
        name: serverName(serverId),
        label: contribution?.label ?? serverId,
        description: contribution?.description,
        configured: false,
        tools: [],
      };
      if (!CONTRIBUTION_ID_RE.test(serverId)) {
        out.push({ ...base, error: `server id "${serverId}" must match [A-Za-z0-9_-]` });
        continue;
      }
      if (takenNames.has(base.name)) {
        out.push({ ...base, error: `server name "${base.name}" is already taken` });
        continue;
      }
      takenNames.add(base.name);
      const config = mergeMcpConfig(contribution, entry, serverId);
      let configured = true;
      try {
        configured = contribution.isConfigured ? contribution.isConfigured(config) : true;
      } catch (err) {
        out.push({ ...base, error: `isConfigured failed: ${message(err)}` });
        continue;
      }
      if (!configured) {
        out.push(base);
        continue;
      }
      try {
        const server = await contribution.create({
          config,
          log,
          plugin: { id: entry.id, version: entry.version, home: dir },
        });
        const tools = toServedTools(server?.tools ?? {}, base.name);
        out.push({ ...base, configured: true, tools });
        log.info(`${base.name}: ${tools.length} tool(s)`);
      } catch (err) {
        out.push({ ...base, error: `create failed: ${message(err)}` });
      }
    }
  }
  return out;
}

/**
 * Skill folders one plugin contributes, with the rules its skills word
 * themselves. A relative `skillPath` resolves against the folder the plugin was
 * loaded from — its own folder next to `server.js`, not the cache copy, which
 * holds the bundle alone. A shipped plugin names its folder absolutely, since
 * it has no copy on disk at all.
 */
function registerSkillFolders(
  entry: PluginManifestEntry,
  dir: string,
  points: AcpPluginExtensionPoint[],
): PluginSkillFolder[] {
  const out: PluginSkillFolder[] = [];
  for (const point of points) {
    for (const raw of asArray<string | SkillFolderContribution>(point.skillPath)) {
      const contribution = typeof raw === "string" ? { path: raw } : raw;
      const value = String(contribution?.path ?? "").trim();
      if (!value) continue;
      const resolved = path.resolve(dir, value);
      const declared: Record<string, string[]> = {};
      for (const [name, ids] of Object.entries(contribution.supersedes ?? {})) {
        const skill = name.trim().toLowerCase();
        const rules = (Array.isArray(ids) ? ids : [])
          .map((id) => String(id ?? "").trim().toLowerCase())
          .filter(Boolean);
        if (skill && rules.length) declared[skill] = rules;
      }
      const known = out.find((folder) => folder.path === resolved);
      if (known) known.supersedes = { ...known.supersedes, ...declared };
      else out.push({ path: resolved, supersedes: declared });
    }
  }
  return out;
}

/** Collect the model providers one plugin contributes (nothing to create yet). */
function registerProviders(
  entry: PluginManifestEntry,
  points: AcpPluginExtensionPoint[],
): RegisteredPluginProvider[] {
  const out: RegisteredPluginProvider[] = [];
  for (const point of points) {
    for (const contribution of asArray<ModelProviderContribution>(point.modelProvider)) {
      const providerId = contribution?.id ?? "";
      const baseUrl = String(contribution?.baseUrl ?? "").trim();
      if (!CONTRIBUTION_ID_RE.test(providerId) || !baseUrl) {
        log.warn(`${entry.id}: provider "${providerId}" needs an id and a baseUrl`);
        continue;
      }
      out.push({
        fullId: `${entry.id}:${providerId}`,
        pluginId: entry.id,
        providerId,
        label: contribution.label || providerId,
        description: contribution.description,
        baseUrl,
        apiKeyHint: contribution.apiKeyHint,
        apiKeyOptional: contribution.apiKeyOptional,
        headers: contribution.headers,
        body: contribution.body,
        models: contribution.models ?? [],
      });
    }
  }
  return out;
}

/** Import one cached bundle and take its extension points; failures are state. */
export async function loadPluginBundle(
  entry: PluginManifestEntry,
  /** `file://` URL of a cached bundle, or a bare specifier of a shipped one. */
  target: string,
  dir: string,
  /** The app ships it: no entry of its own, and no cache directory either. */
  shipped = false,
): Promise<LoadedPlugin & { extensions: AcpPluginExtensionPoint[] }> {
  const state: LoadedPlugin = {
    id: entry.id,
    version: entry.version,
    enabled: true,
    status: "failed",
    dir,
    mcpServerCount: 0,
    modelProviderCount: 0,
    skillCount: 0,
    ...(shipped ? { shipped: true } : {}),
  };
  try {
    const mod = (await import(target)) as { default?: unknown };
    if (typeof mod.default !== "function") throw new Error("bundle has no default export function");
    const context: PluginRegistrationContext = { config: entry.config, home: dir, log };
    const definition = (await (mod.default as (c: PluginRegistrationContext) => unknown)(
      context,
    )) as PluginDefinition;
    const points = Array.isArray(definition?.extensions) ? definition.extensions : [];
    state.mcpServerCount = points.reduce((n, p) => n + asArray(p.mcpServer).length, 0);
    state.modelProviderCount = points.reduce((n, p) => n + asArray(p.modelProvider).length, 0);
    state.skillCount = points.reduce((n, p) => n + asArray(p.skillPath).length, 0);
    state.status = "loaded";
    return { ...state, extensions: points };
  } catch (err) {
    return {
      ...state,
      error: err instanceof Error ? err.message : String(err),
      extensions: [],
    };
  }
}

/**
 * Load every enabled plugin of the configured source. Called once at boot;
 * safe to call again in tests. Never throws: a failure is state, not a crash.
 */
export async function loadPlugins(): Promise<void> {
  const settings = await getSettings();
  const source = pluginSourceFrom(settings);
  const label = sourceLabel(source);
  const extensions: AcpPluginExtensionPoint[] = [];
  const plugins: LoadedPlugin[] = [];
  const mcpServers: RegisteredPluginMcp[] = [];
  const providers: RegisteredPluginProvider[] = [];
  const skillFolders: PluginSkillFolder[] = [];
  const takenMcpNames = new Set<string>();
  let warnings: string[] = [];
  registry.bootSourceLabel = sourceKey(label, settings.pluginEntries);

  // A plugin added by hand has nothing to be relative to, so its paths resolve
  // like any other path the server is given; a manifest entry resolves against
  // the file that named it.
  const wanted: Array<{
    entry: PluginManifestEntry;
    base: ResolvedPluginSource | null;
    /** Module that is already part of the build, for a shipped plugin. */
    shipped?: string;
  }> = ownPluginEntries(settings).map((entry) => ({ entry, base: null }));
  // The config file is optional: with no source set, a missing default file is
  // not a failure — plugins added by hand are the whole point of that setup.
  const sourceReady =
    Boolean(source) &&
    (settings.pluginsConfig.trim() !== "" ||
      (source?.kind === "path" && existsSync(source.path)));
  if (source && sourceReady) {
    try {
      const read = await readManifest(source);
      warnings = [...read.warnings];
      if (read.staleAt) {
        console.warn(`[plugin] using the manifest cached at ${read.staleAt}`);
      }
      wanted.push(...read.entries.map((entry) => ({ entry, base: source })));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings = [...warnings, `could not read the plugin source (${label}): ${message}`];
      console.warn(`[plugin] ${message}`);
    }
  }
  // The app's own plugins come last: an entry of the source and, above all, the
  // user's own row take the id over — which is how one of them gets switched
  // off without a setting of its own.
  wanted.push(
    ...SHIPPED_PLUGINS.map((plugin) => ({
      entry: { id: plugin.id, version: plugin.version, enabled: true, server: null, config: {} },
      base: null,
      shipped: plugin.module,
    })),
  );

  // One id, one plugin: what the user typed in this app beats the same id in
  // the file, and the second one is reported rather than silently dropped.
  const seenIds = new Set<string>();
  for (const { entry, base, shipped } of wanted) {
    if (seenIds.has(entry.id)) {
      warnings = [...warnings, `plugin "${entry.id}" is listed twice — the first entry is used`];
      continue;
    }
    seenIds.add(entry.id);
    if (!PLUGIN_ID_RE.test(entry.id)) {
      plugins.push({
        id: entry.id,
        version: entry.version,
        enabled: true,
        status: "failed",
        error: `id "${entry.id}" must be [a-z0-9-]`,
        mcpServerCount: 0,
        modelProviderCount: 0,
        skillCount: 0,
        ...(shipped ? { shipped: true } : {}),
      });
      continue;
    }
    if (!entry.enabled) {
      plugins.push({
        id: entry.id,
        version: entry.version,
        enabled: false,
        status: "skipped",
        mcpServerCount: 0,
        modelProviderCount: 0,
        skillCount: 0,
        ...(shipped ? { shipped: true } : {}),
      });
      continue;
    }
    if (!entry.server && !shipped) {
      plugins.push({
        id: entry.id,
        version: entry.version,
        enabled: true,
        status: "failed",
        error: "no server entry",
        mcpServerCount: 0,
        modelProviderCount: 0,
        skillCount: 0,
        ...(shipped ? { shipped: true } : {}),
      });
      continue;
    }
    try {
      // A shipped plugin is already part of the build: nothing to resolve,
      // download or hash — the import is the load. It has no copy of its own on
      // disk, so `home` is empty and it names absolute paths instead.
      let target: string;
      let dir: string;
      let sourceDir: string | null = null;
      if (shipped) {
        target = shipped;
        dir = "";
      } else {
        const resolved = resolvePluginSource(entry.server ?? "", {
          cwd: process.cwd(),
          home: os.homedir(),
          base,
        });
        if (!resolved) throw new Error("empty server entry");
        const file = await cachePluginBundle(entry.id, entry.version, resolved);
        target = pathToFileURL(file).href;
        dir = path.dirname(file);
        // A skill folder ships next to the bundle in the source, not in the cache.
        if (resolved.kind === "path") sourceDir = path.dirname(resolved.path);
      }
      const { extensions: points, ...loaded } = await loadPluginBundle(entry, target, dir, Boolean(shipped));
      plugins.push(loaded);
      if (loaded.status === "loaded") {
        extensions.push(...points);
        mcpServers.push(...(await registerMcpServers(entry, dir, points, takenMcpNames)));
        providers.push(...registerProviders(entry, points));
        skillFolders.push(...registerSkillFolders(entry, sourceDir ?? dir, points));
        log.info(`${entry.id}@${entry.version}: loaded from ${target}`);
      } else {
        log.warn(`${entry.id}: ${loaded.error}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      plugins.push({
        id: entry.id,
        version: entry.version,
        enabled: true,
        status: "failed",
        error: message,
        mcpServerCount: 0,
        modelProviderCount: 0,
        skillCount: 0,
        ...(shipped ? { shipped: true } : {}),
      });
      log.warn(`${entry.id}: ${message}`);
    }
  }

  registry.extensions = extensions;
  registry.plugins = plugins;
  registry.mcpServers = mcpServers;
  registry.providers = providers;
  // One folder per path: two plugins may name the same one, so merge their claims.
  registry.skillFolders = skillFolders.reduce<PluginSkillFolder[]>((out, folder) => {
    const known = out.find((row) => row.path === folder.path);
    if (known) known.supersedes = { ...known.supersedes, ...folder.supersedes };
    else out.push(folder);
    return out;
  }, []);
  // Providers and skill folders are read through the settings, so the settings
  // module is handed these sources instead of importing the loader (which
  // imports it back).
  setPluginProviderSource(pluginProviders);
  setPluginSkillSource(pluginSkillFolders);
  registry.warnings = warnings;
  registry.loadedAt = new Date().toISOString();
}
