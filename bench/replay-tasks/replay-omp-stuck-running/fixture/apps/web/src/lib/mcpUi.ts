import type { McpServerConfig } from "@acpio/shared";
import { parseMcpRemoteConfig } from "@acpio/shared";

export function mcpTypeMessageKey(
  type: McpServerConfig["type"],
): "settings.mcpStdio" | "settings.mcpRemote" | "settings.mcpLocal" {
  if (type === "stdio") return "settings.mcpStdio";
  if (type === "remote") return "settings.mcpRemote";
  return "settings.mcpLocal";
}

/** Connection JSON a draft starts from: the saved JSON, else the legacy fields. */
export function mcpRemoteConfigDraft(server: McpServerConfig): string {
  if (server.remoteConfig?.trim()) return server.remoteConfig;
  const merged = parseMcpRemoteConfig(server);
  return Object.keys(merged).length ? JSON.stringify(merged, null, 2) : "";
}

/** Env JSON a draft starts from: the saved JSON, else the legacy env rows. */
export function mcpEnvConfigDraft(server: McpServerConfig): string {
  if (server.envConfig?.trim()) return server.envConfig;
  if (!server.env?.length) return "";
  const obj: Record<string, string> = {};
  for (const row of server.env) {
    if (row.name?.trim()) obj[row.name.trim()] = String(row.value ?? "");
  }
  return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : "";
}

/**
 * Edited draft → the row to persist. Trims fields, clears the fields the
 * chosen transport does not use and assigns an id for a new server. Null when
 * the draft is not saveable (no name, or the transport is incomplete).
 */
export function normalizeMcpDraft(draft: McpServerConfig): McpServerConfig | null {
  const name = draft.name.trim();
  const id = draft.id || `mcp-${Date.now().toString(36)}`;
  const type = draft.type === "stdio" ? "stdio" : draft.type === "remote" ? "remote" : "local";
  if (type === "stdio") {
    const command = (draft.command ?? "").trim();
    if (!name || !command) return null;
    return {
      id,
      name,
      enabled: draft.enabled,
      type: "stdio",
      command,
      args: (draft.args ?? []).map((a) => a.trim()).filter(Boolean),
      envConfig: draft.envConfig?.trim() || undefined,
      env: undefined,
    };
  }
  const url = (draft.url ?? "").trim();
  if (!name || !url) return null;
  return {
    ...draft,
    id,
    name,
    type,
    url,
    token: undefined,
    headers: undefined,
    remoteConfig: draft.remoteConfig?.trim() || undefined,
    command: undefined,
    args: undefined,
    env: undefined,
    envConfig: undefined,
  };
}
