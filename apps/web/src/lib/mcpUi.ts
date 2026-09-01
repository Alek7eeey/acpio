import type { McpServerConfig } from "@acpio/shared";

export function mcpTypeMessageKey(
  type: McpServerConfig["type"],
): "settings.mcpStdio" | "settings.mcpRemote" | "settings.mcpLocal" {
  if (type === "stdio") return "settings.mcpStdio";
  if (type === "remote") return "settings.mcpRemote";
  return "settings.mcpLocal";
}
