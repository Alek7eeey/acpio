import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCursorAcpSessions } from "./localTranscript.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("listCursorAcpSessions", () => {
  it("skips empty probe folders and keeps titled stores", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-"));
    dirs.push(root);
    const probe = path.join(root, "11111111-1111-4111-8111-111111111111");
    fs.mkdirSync(probe);
    fs.writeFileSync(path.join(probe, "meta.json"), JSON.stringify({ cwd: "E:/tmp" }));
    fs.writeFileSync(path.join(probe, "store.db"), "");
    const real = path.join(root, "22222222-2222-4222-8222-222222222222");
    fs.mkdirSync(real);
    fs.writeFileSync(
      path.join(real, "meta.json"),
      JSON.stringify({ cwd: "E:/share/acpio", title: "How are you" }),
    );
    fs.writeFileSync(path.join(real, "store.db"), Buffer.alloc(8192, 1));
    const rows = listCursorAcpSessions({ root, chatsRoot: path.join(root, "no-chats") });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(rows[0]?.title).toBe("How are you");
  });

  it("filters by exact cwd, not parent or nested folders", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-"));
    dirs.push(root);
    const write = (id: string, cwd: string) => {
      const dir = path.join(root, id);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ cwd, title: cwd }));
      fs.writeFileSync(path.join(dir, "store.db"), Buffer.alloc(8192, 1));
    };
    write("11111111-1111-4111-8111-111111111111", "C:/MyFolder/ips");
    write("22222222-2222-4222-8222-222222222222", "C:/MyFolder/ips/ips_10");
    write("33333333-3333-4333-8333-333333333333", "C:/MyFolder/ips/ips_10/consoleServer");
    write("44444444-4444-4444-8444-444444444444", "C:/MyFolder");
    const rows = listCursorAcpSessions({
      root,
      chatsRoot: path.join(root, "no-chats"),
      cwd: "C:/MyFolder/ips/ips_10",
    });
    expect(rows.map((r) => r.cwd.replace(/\\/g, "/"))).toEqual(["C:/MyFolder/ips/ips_10"]);
  });
});
