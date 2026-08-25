import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listOmpSessions, readOmpSessionTranscript } from "./localSessions.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-"));
  dirs.push(root);
  const folder = path.join(root, "--E--share-acpio--");
  fs.mkdirSync(folder);
  const id = "019fea5d-fc92-7000-86cd-c486c1ed8a72";
  const file = path.join(folder, `2026-08-10T06-30-55-891Z_${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-08-10T06:30:55.891Z",
        cwd: "E:\\share\\acpio",
        title: "Restore probe",
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        message: { role: "user", content: [{ type: "text", text: "ping from console" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "short thought" },
            { type: "text", text: "pong" },
            { type: "toolCall", name: "read" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "t1",
        message: { role: "toolResult", content: [{ type: "text", text: "skip me" }] },
      }),
    ].join("\n"),
    "utf8",
  );
  return { root, id };
}

describe("OMP local sessions", () => {
  it("lists jsonl sessions with cwd and title", () => {
    const { root, id } = fixture();
    const rows = listOmpSessions({ root, cwd: "E:/share/acpio" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe(id);
    expect(rows[0]?.title).toBe("Restore probe");
    expect(rows[0]?.cwd.replace(/\\/g, "/")).toMatch(/share\/acpio$/i);
  });

  it("reads user/assistant turns and skips tools", () => {
    const { root, id } = fixture();
    const tx = readOmpSessionTranscript(id, { root });
    expect(tx?.turns).toEqual([
      { role: "user", text: "ping from console" },
      { role: "assistant", text: "pong", thought: "short thought" },
    ]);
  });

  it("skips probe/temp session folders", () => {
    const { root, id } = fixture();
    const junk = path.join(root, "-tmp-omp-acp-probe-zzzz-proj");
    fs.mkdirSync(junk);
    fs.writeFileSync(
      path.join(junk, `2026-08-10T06-30-55-891Z_019fea5d-0000-7000-86cd-c486c1ed8a72.jsonl`),
      JSON.stringify({ type: "session", id: "019fea5d-0000-7000-86cd-c486c1ed8a72", cwd: "/tmp" }) +
        "\n" +
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "probe" }] } }),
      "utf8",
    );
    const rows = listOmpSessions({ root });
    expect(rows.map((r) => r.sessionId)).toEqual([id]);
  });
});
