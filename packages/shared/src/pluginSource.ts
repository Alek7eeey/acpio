/**
 * Where a plugin comes from: the config source in Settings, and each `server`
 * entry inside that config. Both accept a URL and a local path, and both are
 * resolved by the server — the browser never touches either.
 *
 * The distinction is made by what the string says, not by trying to parse it:
 * `new URL("C:\\plugins\\config.json")` succeeds with the scheme `c:`, so a
 * Windows path would silently become an unreadable "URL".
 */

/** A source that was resolved: a fetchable URL or a filesystem path. */
export type ResolvedPluginSource = { kind: "url"; url: string } | { kind: "path"; path: string };

/**
 * One plugin added by hand in Settings → Plugins: the same fields a manifest
 * entry carries, without the file. A local path resolves against the server's
 * working directory (nothing to be relative to), a URL is fetched.
 */
export interface PluginEntryConfig {
  /** Names the plugin: the cache folder, `plugin:<id>:…` ids and tool names. */
  id: string;
  /** URL or path to the built bundle. */
  server: string;
  version?: string;
  /** Absent = on. */
  enabled?: boolean;
  /** The plugin's own config, handed to its bundle as-is — credentials here. */
  config?: Record<string, unknown>;
}

/** One plugin as the settings page lists it (`GET /api/plugins`). */
export interface LoadedPluginDto {
  id: string;
  version: string;
  enabled: boolean;
  status: "loaded" | "skipped" | "failed";
  error?: string;
  /** Cached bundle path, for debugging. */
  dir?: string;
  mcpServerCount: number;
  modelProviderCount: number;
  /** Skill folders the plugin contributes (each holds `<name>/SKILL.md`). */
  skillCount: number;
  /**
   * Ships with the app instead of the configured source: it has no entry of its
   * own, and a row with its id and `enabled: false` is how the user turns it off.
   */
  shipped?: boolean;
}

/**
 * One skill folder a plugin ships, as the loader resolved it (plugin-api's
 * `skillPath`): an absolute folder plus the base rules its skills word
 * themselves, by skill name. Filled at boot and never stored.
 */
export interface PluginSkillFolder {
  path: string;
  supersedes: Record<string, string[]>;
}

/** One MCP server a plugin contributes, as the MCP settings list it. */
export interface PluginMcpServerDto {
  /** `plugin:<pluginId>:<serverId>` — the id the MCP switches use. */
  id: string;
  /** Name the harness sees; tool names are built from it. */
  name: string;
  label: string;
  pluginId: string;
  serverId: string;
  /** False = missing its config: listed, but never attached to a chat. */
  configured: boolean;
  tools: number;
  error?: string;
}

/** Plugin host state: the source, what loaded at boot, what waits for a restart. */
export interface PluginsStateDto {
  source: ResolvedPluginSource | null;
  /** The same source as text, as resolved by the server. */
  sourceLabel: string;
  /** Folder the cached bundles live in; also the default config location. */
  dir: string;
  loadedAt: string | null;
  /** The setting changed since boot — applied on the next server start. */
  pendingRestart: boolean;
  warnings: string[];
  plugins: LoadedPluginDto[];
  /** MCP servers the loaded plugins contribute, in registration order. */
  mcpServers: PluginMcpServerDto[];
}

/** `url` only for the schemes we can fetch or read; everything else is a path. */
export function pluginSourceKind(value: string): "url" | "path" {
  return /^(https?|file):\/\//i.test(value.trim()) ? "url" : "path";
}

/** Absolute POSIX path, drive path (`C:/…`) or UNC (`//host/share`). */
function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:\//.test(value);
}

/**
 * Join `rel` onto an absolute `base`, collapsing `//`, `.` and `..` — the same
 * job `node:path` does, hand-rolled because this module also ships to the
 * browser, where `node:path` does not exist.
 */
function joinPath(base: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${base.replace(/\/+$/, "")}/${rel}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `${base.startsWith("/") ? "/" : ""}${out.join("/")}`;
}

/** Folder of a slashed file path (`C:/plugins/config.json` → `C:/plugins`). */
function dirNameOf(file: string): string {
  const at = file.lastIndexOf("/");
  if (at < 0) return ".";
  return at === 0 ? "/" : file.slice(0, at);
}

/** `file:///C:/x` → `C:/x`, `file:///etc/x` → `/etc/x`. */
function fileUrlToPath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path;
}

/**
 * Resolve one source. `base` is the config file that named it — a relative
 * entry resolves against that file's folder, so a plugin folder can be moved
 * as a whole; without a base a relative path resolves against the server's
 * working directory. `~` is the server user's home. Returns `null` for
 * an empty source so callers can apply their own default. Throws only on a
 * source that claims to be a URL and is not one.
 */
export function resolvePluginSource(
  value: string,
  opts: { cwd: string; home: string; base?: ResolvedPluginSource | null },
): ResolvedPluginSource | null {
  const raw = value.trim();
  if (!raw) return null;

  if (pluginSourceKind(raw) === "url") {
    const url = new URL(raw);
    if (url.protocol === "file:") return { kind: "path", path: fileUrlToPath(url) };
    return { kind: "url", url: url.toString() };
  }

  const slashed = raw.replace(/\\/g, "/");
  const expanded =
    slashed === "~" || slashed.startsWith("~/")
      ? `${opts.home.replace(/\/+$/, "")}${slashed.slice(1)}`
      : slashed;
  if (isAbsolutePath(expanded)) return { kind: "path", path: expanded };

  const base = opts.base ?? null;
  if (!base) return { kind: "path", path: joinPath(opts.cwd, expanded) };
  if (base.kind === "url") return { kind: "url", url: new URL(expanded, base.url).toString() };
  return { kind: "path", path: joinPath(dirNameOf(base.path), expanded) };
}
