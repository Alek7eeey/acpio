import { describe, expect, it } from "vitest";
import { probeStdio } from "./mcpStatus.js";

describe("probeStdio", () => {
  it("returns true when the process answers initialize over stdout", async () => {
    const script = `
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => {
        buf += c;
        if (buf.includes("initialize")) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "t", version: "0" } },
          }) + "\\n");
        }
      });
    `;
    await expect(
      probeStdio({
        id: "t",
        name: "t",
        enabled: true,
        type: "stdio",
        command: process.execPath,
        args: ["-e", script],
      }),
    ).resolves.toBe(true);
  });

  it("returns false when the command is missing", async () => {
    await expect(
      probeStdio({
        id: "t",
        name: "t",
        enabled: true,
        type: "stdio",
        command: "",
      }),
    ).resolves.toBe(false);
  });
});
