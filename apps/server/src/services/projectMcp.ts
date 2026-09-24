import { readFile } from "node:fs/promises";
import path from "node:path";
import { type McpServerConfig, type ProjectMcpInfo, canonicalCwd, normalizeMcpProjectFiles, parseMcpProjectFile } from "@acpio/shared";

/**
 * Read the configured MCP files under one chat's folder (Settings → MCP list,
 * `.omp/mcp.json` / `.cursor/mcp.json` / `.agents/mcp.json` by default). Paths
 * are relative to the cwd and may not escape it. A missing file is normal; an
 * unreadable or malformed one becomes a warning instead of failing the session.
 * The first file in the list owns a server name, matching the app-configured
 * list, which keeps its names too (see `effectiveMcpServers`).
 */
export async function discoverProjectMcp(
  cwd: string | null | undefined,
  files: unknown,
): Promise<ProjectMcpInfo> {
  const root = canonicalCwd(cwd);
  const rels = root ? normalizeMcpProjectFiles(files) : [];
  if (!root || !rels.length) return { servers: [], warnings: [] };

  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  const names = new Set<string>();
  for (const rel of rels) {
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (inside.startsWith("..") || path.isAbsolute(inside)) continue;
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const parsed = parseMcpProjectFile(text, rel, process.env);
    warnings.push(...parsed.warnings);
    for (const server of parsed.servers) {
      if (names.has(server.name)) continue;
      names.add(server.name);
      servers.push(server);
    }
  }
  return { servers, warnings };
}
