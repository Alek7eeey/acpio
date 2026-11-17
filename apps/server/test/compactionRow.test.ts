// The compaction row is written in two halves: the pass names itself and leaves
// the squeezed size as a `*`, and the provider's count of the next request fills
// it in. Between them sits one turn, so the harness sends the second half as an
// update of its own — and the row must be the same row, not a second one saying
// "Контекст сжат" twice.

import { describe, it, expect, beforeEach } from "vitest";
import { buildApp, resetDb } from "./test-utils.js";
import { createSession, getSessionDetail } from "../src/services/sessions.js";
import { handleUpdate, sessionRuntime } from "../src/acp/sessionManager.js";

let sessionId: string;

beforeEach(async () => {
  await buildApp();
  await resetDb();
  const session = await createSession({ provider: "builtin", cwd: ".", mode: "agent" });
  sessionId = session.id;
});

/** The compaction parts of the session, in the order the reader sees them. */
async function compactionParts() {
  const detail = await getSessionDetail(sessionId);
  return (detail?.messages ?? [])
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "compaction");
}

async function reportPass(passId: number) {
  await handleUpdate(sessionRuntime(sessionId), {
    kind: "compaction",
    raw: {
      sessionUpdate: "compaction",
      passId,
      manual: false,
      coveredBefore: 0,
      coveredAfter: 12,
      // The provider's count of the request the pass started from (chat
      // 9590a5eb: the estimate here said 200 135 where the bill said 258 133).
      tokensBefore: 258_133,
      tokensAfterPending: true,
      summary: "Задача: починить парсер",
    },
  });
}

async function pricePass(passId: number, tokensAfter: number) {
  await handleUpdate(sessionRuntime(sessionId), {
    kind: "compaction",
    raw: { sessionUpdate: "compaction_update", passId, tokensAfter },
  });
}

describe("the compaction row", () => {
  beforeEach(() => {
    sessionRuntime(sessionId).acceptingStream = true;
  });

  it("holds a star until the provider prices the view the pass left", async () => {
    await reportPass(1);

    const [row] = await compactionParts();
    expect(row?.payload.tokensBefore).toBe(258_133);
    // No estimate on the row: it is the one number known to have lied.
    expect(row?.payload.tokensAfter).toBeUndefined();
    expect(row?.payload.tokensAfterPending).toBe(true);

    await pricePass(1, 90_600);

    const [priced] = await compactionParts();
    expect(priced?.id).toBe(row?.id);
    expect(priced?.payload.tokensAfter).toBe(90_600);
    expect(priced?.payload.tokensAfterPending).toBe(false);
  });

  it("fills the row of the pass it names, not whatever came last", async () => {
    await reportPass(1);
    await reportPass(2);

    // Out of order on purpose: a turn that ends between two passes leaves the
    // first row waiting while the second one is already written.
    await pricePass(1, 70_000);

    const rows = await compactionParts();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload.tokensAfter).toBe(70_000);
    expect(rows[1]?.payload.tokensAfter).toBeUndefined();
    expect(rows[1]?.payload.tokensAfterPending).toBe(true);
  });

  it("ignores a price for a row this process never wrote", async () => {
    await reportPass(1);
    // A chat resumed elsewhere: the number is real, but there is no row here to
    // put it on — and a row invented for it would be a squeeze nobody ran.
    await pricePass(99, 12_000);

    const rows = await compactionParts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.tokensAfter).toBeUndefined();
  });
});
