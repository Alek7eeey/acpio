import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { chatFolders, sessions } from "../src/db/schema.js";
import { ensureSchema } from "../src/db/ensureSchema.js";
import { getSessionDetail, repairStoredCwds } from "../src/services/sessions.js";
import { listFolders } from "../src/services/folders.js";
import { resetDb } from "./test-utils.js";

/**
 * A drive root used to be stored as the drive-relative "C:" — OMP answers
 * `session/new` for it with `-32603 Internal error`, so the chat never boots.
 * Existing rows are rewritten at startup; the DTOs never hand out a stale one.
 */
describe("cwd repair", () => {
  beforeEach(async () => {
    await ensureSchema();
    await resetDb();
    db.run(sql`DELETE FROM chat_folders`);
  });

  it("rewrites a drive-relative chat cwd to the drive root", async () => {
    await db
      .insert(sessions)
      .values({ id: "11111111-1111-4111-8111-111111111111", title: "chat", provider: "omp", cwd: "C:" });

    expect(await repairStoredCwds()).toEqual(["C: -> C:/"]);
    expect((await getSessionDetail("11111111-1111-4111-8111-111111111111"))?.cwd).toBe("C:/");
    // Idempotent: a repaired row is left alone on the next start.
    expect(await repairStoredCwds()).toEqual([]);
  });

  it("moves the folder row onto the repaired key instead of duplicating it", async () => {
    await db.insert(chatFolders).values([
      { cwd: "C:", sortOrder: 0 },
      { cwd: "C:/", sortOrder: 1 },
    ]);

    await repairStoredCwds();
    expect(await listFolders()).toEqual(["C:/"]);
  });

  it("leaves an empty or ordinary cwd alone", async () => {
    await db
      .insert(sessions)
      .values({ id: "22222222-2222-4222-8222-222222222222", title: "chat", provider: "omp", cwd: "E:/proj" });

    expect(await repairStoredCwds()).toEqual([]);
    expect((await getSessionDetail("22222222-2222-4222-8222-222222222222"))?.cwd).toBe("E:/proj");
  });

  it("hands out a canonical cwd even before the row is repaired", async () => {
    await db
      .insert(sessions)
      .values({ id: "33333333-3333-4333-8333-333333333333", title: "chat", provider: "omp", cwd: "E:/proj/" });

    expect((await getSessionDetail("33333333-3333-4333-8333-333333333333"))?.cwd).toBe("E:/proj");
  });
});
