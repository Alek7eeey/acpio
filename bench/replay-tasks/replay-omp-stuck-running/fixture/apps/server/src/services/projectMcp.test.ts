import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProjectMcp } from "./projectMcp.js";

describe("discoverProjectMcp", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function project(files: Record<string, string>): Promise<string> {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-mcp-"));
    dirs.push(cwd);
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(cwd, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, body, "utf8");
    }
    return cwd;
  }

  it("reads the default files and keeps the first declaration of a name", async () => {
    const cwd = await project({
      ".omp/mcp.json": '{"mcpServers":{"fs":{"command":"npx","args":["-y","fs"]}}}',
      ".cursor/mcp.json":
        '{"mcpServers":{"fs":{"command":"other"},"gitea":{"url":"https://gitea.example/mcp"}}}',
    });
    const info = await discoverProjectMcp(cwd, undefined);
    expect(info.warnings).toEqual([]);
    expect(info.servers.map((s) => [s.id, s.command ?? s.url])).toEqual([
      ["file:.omp/mcp.json:fs", "npx"],
      ["file:.cursor/mcp.json:gitea", "https://gitea.example/mcp"],
    ]);
  });

  it("honours a configured file list and ignores the rest", async () => {
    const cwd = await project({
      ".omp/mcp.json": '{"mcpServers":{"a":{"command":"x"}}}',
      "tools/servers.json": '{"mcpServers":{"b":{"command":"y"}}}',
    });
    const info = await discoverProjectMcp(cwd, ["tools/servers.json"]);
    expect(info.servers.map((s) => s.id)).toEqual(["file:tools/servers.json:b"]);
    expect((await discoverProjectMcp(cwd, [])).servers).toEqual([]);
  });

  it("reports malformed files as warnings without dropping the good ones", async () => {
    const cwd = await project({
      ".omp/mcp.json": "{oops",
      ".agents/mcp.json": '{"mcpServers":{"ok":{"command":"x"}}}',
    });
    const info = await discoverProjectMcp(cwd, undefined);
    expect(info.warnings).toEqual([".omp/mcp.json: invalid JSON"]);
    expect(info.servers.map((s) => s.id)).toEqual(["file:.agents/mcp.json:ok"]);
  });

  it("returns nothing for a missing folder, an absent file or a cwd that escapes", async () => {
    const cwd = await project({});
    expect(await discoverProjectMcp(cwd, [".omp/mcp.json"])).toEqual({ servers: [], warnings: [] });
    expect(await discoverProjectMcp("", [".omp/mcp.json"])).toEqual({
      servers: [],
      warnings: [],
    });
    expect(await discoverProjectMcp(cwd, ["../outside/mcp.json"])).toEqual({
      servers: [],
      warnings: [],
    });
  });
});
