import { describe, expect, it } from "vitest";
import bundle from "./server.js";

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("example plugin", () => {
  it("registers an MCP server whose tool answers from its config", async () => {
    const def = await bundle({ config: {}, home: "/tmp/plugin", log });
    const point = def.extensions[0];
    const contribution = Array.isArray(point.mcpServer) ? point.mcpServer[0] : point.mcpServer;
    const server = await contribution!.create({
      config: { greeting: "Привет" },
      log,
      plugin: { id: "example", version: "0.1.0", home: "/tmp/plugin" },
    });
    await expect(server.tools.greet.handler({ name: "мир" })).resolves.toBe("Привет мир!");
  });

  it("recommends its models enabled", async () => {
    const def = await bundle({ config: {}, home: "/tmp/plugin", log });
    const provider = def.extensions[0].modelProvider;
    const contribution = Array.isArray(provider) ? provider[0] : provider;
    expect(contribution!.models.map((m) => m.id)).toEqual(["demo-small", "demo-large"]);
  });
});
