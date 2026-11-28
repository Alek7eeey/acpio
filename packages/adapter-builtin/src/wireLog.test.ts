import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderKeyCursors, providerFetch } from "./keys.js";
import {
  ContextDriftStop,
  forgetWireLogHeads,
  isContextDriftStop,
  resetWireLogState,
  sharedPrefix,
  withWireLog,
  wireLogDir,
  type ContextDrift,
  type WireHeadInfo,
} from "./wireLog.js";

/** A response shape the SDK/most relays answer with: JSON plus usage. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("wire log", () => {
  let dir = "";
  const saved = { dir: process.env.ACPIO_WIRE_LOG_DIR, mode: process.env.ACPIO_WIRE_LOG };

  beforeEach(() => {
    resetProviderKeyCursors();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-log-"));
    process.env.ACPIO_WIRE_LOG_DIR = dir;
    process.env.ACPIO_WIRE_LOG = "1";
    resetWireLogState();
  });

  afterEach(() => {
    if (saved.dir === undefined) delete process.env.ACPIO_WIRE_LOG_DIR;
    else process.env.ACPIO_WIRE_LOG_DIR = saved.dir;
    if (saved.mode === undefined) delete process.env.ACPIO_WIRE_LOG;
    else process.env.ACPIO_WIRE_LOG = saved.mode;
    resetWireLogState();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const lines = (): any[] =>
    fs
      .readFileSync(path.join(dir, "sess-1.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  /** The self-contained cache-miss events written for this chat. */
  const driftEvents = (): any[] => {
    const folder = path.join(wireLogDir(), "sess-1");
    if (!fs.existsSync(folder)) return [];
    return fs
      .readdirSync(folder)
      .filter((name) => name.startsWith("drift-"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")));
  };

  it("records the request's head hashes, the key fingerprint and the answer's usage", async () => {
    const fetch = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90 }, completion_tokens: 5 } })) as typeof globalThis.fetch,
    );
    await fetch("https://relay.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-key" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [request, response] = lines();
    expect(request.kind).toBe("request");
    expect(request.messages).toBe(2);
    expect(request.key).toHaveLength(8);
    expect(request.key).not.toContain("secret");
    expect(request.headers.authorization).toBe(`Bearer <${request.key}>`);
    expect(response.kind).toBe("response");
    expect(response.usage).toEqual({ input: 100, cached: 90, output: 5 });
  });

  it("names how much of the prefix matches the request before it", async () => {
    const base = (async () => jsonResponse({ usage: { prompt_tokens: 10, completion_tokens: 1 } })) as typeof globalThis.fetch;
    const fetch = withWireLog({ sessionId: "sess-1", providerId: "legacy" }, base);
    const head = [{ role: "user" as const, content: "one" }];
    const call = (messages: unknown[], key = "k1") =>
      fetch("https://relay.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "m", messages }),
      });

    await call(head);
    await call([...head, { role: "assistant", content: "two" }]);
    // A rewritten head is what kills a provider's cache: the shared prefix
    // collapses to zero even though every message after it is new anyway.
    await call([{ role: "user", content: "one!" }, { role: "assistant", content: "two" }], "k2");

    const requests = lines().filter((line) => line.kind === "request");
    expect(requests[0].prefixSame).toBeNull(); // nothing to compare against
    expect(requests[1].prefixSame).toBe(1); // the head survived, the tail grew
    expect(requests[2].prefixSame).toBe(0); // the head changed: full re-read
    expect(requests[2].keyChanged).toBe(true);
  });

  it("keeps the head hashes that tell a system-prompt change from a tool-list change", async () => {
    const base = (async () => jsonResponse({})) as typeof globalThis.fetch;
    const fetch = withWireLog({ sessionId: "sess-1", providerId: "legacy" }, base);
    const send = (system: string, tools: unknown[]) =>
      fetch("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", system, tools, messages: [{ role: "user", content: "x" }] }),
      });
    await send("rules", [{ name: "bash" }]);
    await send("rules", [{ name: "bash" }]);
    await send("rules", [{ name: "bash" }, { name: "read" }]);
    const requests = lines().filter((line) => line.kind === "request");
    expect(requests[1].toolsChanged).toBe(false);
    expect(requests[2].toolsChanged).toBe(true);
    expect(requests[2].systemChanged).toBe(false);
  });

  it("names a changed system prompt that rides messages[0]", async () => {
    // The built-in agent's endpoint has no `system` field: the whole prompt
    // head — reply language, plan tool, the project-rules block, the MCP
    // servers — is the first message. Hashing only `body.system` left that
    // request reading "0 of 279" with `systemChanged: false`, so a chat whose
    // rules block grew could never say which head had moved (a26a4eca).
    const base = (async () => jsonResponse({})) as typeof globalThis.fetch;
    const fetch = withWireLog({ sessionId: "sess-1", providerId: "builtin" }, base);
    const send = (rules: string) =>
      fetch("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          messages: [
            { role: "system", content: rules },
            { role: "user", content: "x" },
          ],
        }),
      });
    await send("rules");
    await send("rules");
    await send("rules\n--- .cursor/rules/browser-automation.mdc ---\nbody");
    const requests = lines().filter((line) => line.kind === "request");
    expect(requests[1].systemChanged).toBe(false);
    expect(requests[1].prefixSame).toBe(2);
    expect(requests[2].systemChanged).toBe(true);
    expect(requests[2].prefixSame).toBe(0);
    expect(requests[2].toolsChanged).toBe(false);
  });

  it("puts the head a chat already sent back on the wire, whatever the build renders now", async () => {
    // The settings are frozen, the text is not: it is rendered by code, so an
    // update that rewords one tool description rewrites the head of every chat
    // open at the restart and the provider bills each of them whole (46523284:
    // 151 104 input tokens, 0 from the cache, for the wording of `apply_plan`;
    // 709ea934: 59 614). The first request keeps the head, the rest get it.
    const sent: Array<Record<string, any>> = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;
    let pinned: { system?: string; tools?: unknown } | undefined;
    const drifts: ContextDrift[] = [];
    const fetch = withWireLog(
      { sessionId: "sess-1", providerId: "builtin" },
      base,
      {
        onDrift: (drift) => {
          drifts.push(drift);
        },
        watch: () => true,
        pin: {
          read: () => pinned,
          write: (head) => {
            pinned = head;
          },
        },
      },
    );
    const send = (system: string, description: string) =>
      fetch("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          tools: [{ type: "function", function: { name: "apply_plan", description } }],
          messages: [
            { role: "system", content: system },
            { role: "user", content: "x" },
          ],
        }),
      });

    await send("head one", "Rejected in silence");
    // A newer build: another wording and another prompt line, same chat.
    await send("head two", "Closed without an answer");

    expect(sent[0].messages[0].content).toBe("head one");
    expect(sent[1].messages[0].content).toBe("head one");
    expect(sent[1].tools[0].function.description).toBe("Rejected in silence");
    // Kept, so nothing moved and nobody is asked to pay for a rewrite.
    expect(drifts).toHaveLength(0);
    const requests = lines().filter((line) => line.kind === "request");
    expect(requests[1].systemChanged).toBe(false);
    expect(requests[1].toolsChanged).toBe(false);
    expect(requests[1].prefixSame).toBe(2);
  });

  it("keeps no head for a request that declares no tools", async () => {
    // A pass without declarations says nothing about the ones the chat keeps:
    // taking its head would strip every tool from the next turn.
    const sent: Array<Record<string, any>> = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;
    let pinned: { system?: string; tools?: unknown } | undefined;
    const fetch = withWireLog({ sessionId: "sess-1", providerId: "builtin" }, base, {
      onHead: () => {},
      pin: {
        read: () => pinned,
        write: (head) => {
          pinned = head;
        },
      },
    });
    const send = (body: Record<string, unknown>) =>
      fetch("https://relay.test/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });

    await send({ model: "m", messages: [{ role: "system", content: "bare" }] });
    expect(pinned).toBeUndefined();
    await send({
      model: "m",
      tools: [{ type: "function", function: { name: "bash" } }],
      messages: [{ role: "system", content: "with tools" }],
    });
    expect(pinned?.system).toBe("with tools");
    await send({ model: "m", messages: [{ role: "system", content: "bare" }] });
    expect(sent[2].messages[0].content).toBe("with tools");
  });

  it("records the key the pool put on the request, and names the swap when it moves", async () => {
    // The log must sit under `providerFetch`, not above it: the pool is what
    // writes the authorization header, so a wrapper outside it would fingerprint
    // an empty string for exactly the chats a key rotation costs.
    const provider = {
      id: "wire-pool",
      name: "Pooled",
      url: "http://127.0.0.1:1/v1",
      apiKeys: ["sk-one", "sk-two"],
      apiKeyMode: "exhausted" as const,
      models: [],
    };
    const answers = [
      new Response('{"error":{"message":"You exceeded your current quota"}}', { status: 429 }),
      jsonResponse({ usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    ];
    let at = 0;
    const base = (async () => answers[Math.min(at++, answers.length - 1)]) as typeof globalThis.fetch;
    const call = providerFetch(
      provider,
      withWireLog({ sessionId: "sess-1", providerId: provider.id }, base),
      async () => null,
    );

    const response = await call("https://relay.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(response.status).toBe(200);
    const requests = lines().filter((line) => line.kind === "request");
    // One entry per attempt: the refused key, then the one that paid.
    expect(requests).toHaveLength(2);
    expect(requests[0].key).toHaveLength(8);
    expect(requests[1].key).toHaveLength(8);
    expect(requests[0].keyChanged).toBe(false);
    expect(requests[1].keyChanged).toBe(true);
  });

  it("reports a head that moved in the middle, switch or no switch", async () => {
    // The chat has to learn about a moving head even when nothing is written to
    // disk: a warning that only exists while logging is on is a warning nobody
    // has when the bill arrives.
    process.env.ACPIO_WIRE_LOG = "0";
    resetWireLogState();
    const drifts: ContextDrift[] = [];
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { onDrift: (drift) => drifts.push(drift) },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };
    const two = { role: "assistant", content: "two" };

    await send([one, two]);
    // A pure append keeps the head: the cache answers the whole prefix.
    await send([one, two, { role: "user", content: "three" }]);
    expect(drifts).toEqual([]);

    // The same three messages with the middle one rewritten: the cache stops at
    // the first message and everything after it is paid in full.
    await send([one, { role: "assistant", content: "TWO" }, { role: "user", content: "three" }]);

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      sessionId: "sess-1",
      messages: 3,
      prevMessages: 3,
      prefixSame: 1,
      systemChanged: false,
      toolsChanged: false,
    });
    // Nothing was written: the report does not depend on the log.
    expect(fs.existsSync(path.join(wireLogDir(), "sess-1.jsonl"))).toBe(false);
  });

  it("forgets a session's head when an edit cut its history", async () => {
    // An edit resumes the session on a shorter transcript. Comparing against the
    // request that had the longer one reports a moved head, and the reader gets
    // a `context_drift` card for an edit they asked for.
    const drifts: ContextDrift[] = [];
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "builtin" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { onDrift: (drift) => drifts.push(drift) },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };
    const two = { role: "assistant", content: "two" };
    const three = { role: "user", content: "three" };
    const four = { role: "assistant", content: "four" };

    await send([one, two, three, four]);
    // Without the cut the shorter history is a drift, which is what the card is for.
    forgetWireLogHeads("sess-2");
    await send([one, two]);
    expect(drifts).toHaveLength(1);

    // With it, the edited chat starts its comparison over instead of crying wolf.
    drifts.length = 0;
    await send([one, two, three, four]);
    forgetWireLogHeads("sess-1");
    await send([one, two]);
    expect(drifts).toEqual([]);
    const head = JSON.parse(
      fs.readFileSync(path.join(wireLogDir(), "sess-1.head.json"), "utf8"),
    ) as Record<string, unknown>;
    // The next request wrote its own head, and it is the only one left. The
    // request counter keeps running — it names this chat's body files, and two
    // requests of one chat must never share a name.
    expect(Object.keys(head)).toHaveLength(1);
    expect(Object.values(head)[0]).toMatchObject({ seq: 4 });
  });

  // The tokens panel splits a chat's bill into "the head moved" and "the provider's
  // cache was cold" — and the second half is only knowable from the request that
  // just went out. A verdict that depends on the diagnostics switch would leave
  // the panel with half a split on every chat that never turned it on.
  it("tells the endpoint about every head, whether it moved or not", async () => {
    process.env.ACPIO_WIRE_LOG = "0";
    resetWireLogState();
    const heads: WireHeadInfo[] = [];
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { onHead: (head) => heads.push(head) },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };
    const two = { role: "assistant", content: "two" };

    await send([one, two]);
    await send([one, two, { role: "user", content: "three" }]);
    await send([one, { role: "assistant", content: "TWO" }, { role: "user", content: "three" }]);

    // The first request has nothing to compare with: no verdict to give.
    expect(heads[0]).toMatchObject({ seq: 1, messages: 2, prevMessages: 0, intact: false });
    // A pure append: the bytes the provider saw last time are still all there.
    expect(heads[1]).toMatchObject({ seq: 2, messages: 3, prevMessages: 2, intact: true });
    // The middle rewritten: the head is not intact, and the panel must not
    // blame the provider for what the chat itself did.
    expect(heads[2]).toMatchObject({ prevMessages: 3, prefixSame: 1, intact: false });
  });

  it("does not look at the head at all while the diagnostics switch is off", async () => {
    process.env.ACPIO_WIRE_LOG = "0";
    resetWireLogState();
    const drifts: ContextDrift[] = [];
    let questions = 0;
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      {
        onDrift: (drift) => drifts.push(drift),
        // Settings → Diagnostics: off means the comparison does not run, so the
        // prompt is not hashed at all — and nothing is remembered for later.
        watch: () => {
          questions += 1;
          return false;
        },
      },
    );
    const one = { role: "user", content: "one" };
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });

    await send([one]);
    await send([{ role: "user", content: "ONE" }]);

    expect(questions).toBe(2);
    expect(drifts).toEqual([]);
  });

  it("keeps a subagent's own prompt off the chat's head", async () => {
    process.env.ACPIO_WIRE_LOG = "0";
    resetWireLogState();
    // A child run is a prompt of its own — another system block, another tool
    // list — and it goes through the chat's own endpoint. Sharing the chat's
    // comparison, its first request read as a break of the parent's head (live:
    // chat dcbbd5d9 drew “0 of 2” before the child had done anything), and its
    // head then made the parent's real request read as one too, while the
    // provider served 8 576 of its 8 970 input tokens from cache.
    const drifts: ContextDrift[] = [];
    const target = { sessionId: "sess-1", providerId: "legacy" };
    const parent = withWireLog(
      target,
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { onDrift: (drift) => drifts.push(drift), watch: () => true },
    );
    const child = withWireLog(
      { ...target, lane: "subagent" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { watch: () => true },
    );
    const send = (call: typeof globalThis.fetch, messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const head = { role: "system", content: "HEAD" };
    const childHead = { role: "system", content: "You are a codebase explorer." };

    await send(parent, [head, { role: "user", content: "one" }]);
    // The child's own head, on its own lane: not a thing the chat's next
    // request may be compared against.
    await send(child, [childHead, { role: "user", content: "list the files" }]);
    await send(parent, [
      head,
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    expect(drifts).toEqual([]);

    // The chat's own break is still reported: a lane separates the two chains,
    // it does not switch the comparison off.
    await send(parent, [
      head,
      { role: "user", content: "ONE" },
      { role: "assistant", content: "two" },
    ]);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      prefixSame: 1,
      prevMessages: 3,
      systemChanged: false,
      toolsChanged: false,
    });
  });

  it("holds the request while the reader decides, and drops it on “stop”", async () => {
    process.env.ACPIO_WIRE_LOG = "0";
    resetWireLogState();
    let sent = 0;
    let decide: (answer: boolean) => void = () => {};
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => {
        sent += 1;
        return jsonResponse({});
      }) as typeof globalThis.fetch,
      {
        // Settings → Diagnostics → context drift: the host asks the reader here
        // and answers with their word — `false` means “stop the turn”.
        onDrift: () =>
          new Promise<boolean>((resolve) => {
            decide = resolve;
          }),
      },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };
    const two = { role: "assistant", content: "two" };

    await send([one, two]);
    const drifted = send([one, { role: "assistant", content: "TWO" }, { role: "user", content: "three" }]);
    // Nothing crosses the wire while the card is up.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toBe(1);

    decide(false);
    await expect(drifted).rejects.toBeInstanceOf(ContextDriftStop);
    expect(sent).toBe(1);
  });

  it("puts the held request itself into the archive the card offers", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    resetWireLogState();
    let decide: (answer: boolean) => void = () => {};
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      {
        onDrift: () =>
          new Promise<boolean>((resolve) => {
            decide = resolve;
          }),
      },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };

    await send([one, { role: "assistant", content: "two" }]);
    const drifted = send([
      { role: "user", content: "ONE" },
      { role: "assistant", content: "two" },
    ]);
    // The card is up and the request is unsent, but “download the chat's logs”
    // has to carry that very body: the request whose head moved is the cause
    // support is looking for, and an archive that stops before it answers
    // nothing (chat 37f44166: “0 of 60”, the other 2 messages nowhere).
    await new Promise((resolve) => setTimeout(resolve, 10));
    const held = lines().filter((line) => line.kind === "request");
    expect(held).toHaveLength(2);
    expect(held[1].prefixSame).toBe(0);
    expect(held[1].bodyFile).toBeTruthy();
    const body = JSON.parse(fs.readFileSync(path.join(dir, held[1].bodyFile), "utf8"));
    expect(body.messages[0].content).toBe("ONE");

    decide(false);
    await expect(drifted).rejects.toBeInstanceOf(ContextDriftStop);
    // A line without a response reads as sent; the drop says otherwise.
    expect(lines().at(-1)).toMatchObject({ kind: "dropped", seq: held[1].seq });
  });

  it("sends the request once the reader says continue", async () => {
    process.env.ACPIO_WIRE_LOG = "0";
    resetWireLogState();
    let sent = 0;
    const shown: ContextDrift[] = [];
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => {
        sent += 1;
        return jsonResponse({});
      }) as typeof globalThis.fetch,
      {
        onDrift: async (drift) => {
          shown.push(drift);
          return true;
        },
      },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };

    await send([one, { role: "assistant", content: "two" }]);
    await send([{ role: "user", content: "ONE" }, { role: "assistant", content: "two" }]);

    expect(shown).toHaveLength(1);
    expect(shown[0]?.prefixSame).toBe(0);
    expect(sent).toBe(2);
  });

  it("recognises its own stop through whatever the SDK wrapped it in", () => {
    expect(isContextDriftStop(new ContextDriftStop())).toBe(true);
    expect(isContextDriftStop(new Error("outer", { cause: new ContextDriftStop() }))).toBe(true);
    expect(isContextDriftStop(new Error("boom"))).toBe(false);
  });

  it("names the message that moved in the request the process before this one sent", async () => {
    process.env.ACPIO_WIRE_LOG = "1";
    resetWireLogState();
    const drifts: ContextDrift[] = [];
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { onDrift: (drift) => drifts.push(drift) },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };
    const two = { role: "assistant", content: "two" };

    await send([one, two]);

    // The server restarts mid-chat: the map is gone, the head file is not.
    resetWireLogState();

    // The first request of the new process carries a compacted history — it
    // shares nothing with the request the chat sent before the reboot. Comparing
    // against `null` instead of that request kept the most expensive break of all
    // quiet (chat c88a1a10: 53 messages became 40 in silence).
    await send([{ role: "user", content: "TWO" }]);

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      sessionId: "sess-1",
      messages: 1,
      prevMessages: 2,
      prefixSame: 0,
    });
    // The counter carries on across the restart, so both runs stay apart in the
    // log as well.
    expect(lines().filter((line) => line.kind === "request").map((line) => line.seq)).toEqual([1, 2]);
  });

  it("ignores a head another fingerprint scheme wrote instead of calling it a break", async () => {
    process.env.ACPIO_WIRE_LOG = "1";
    resetWireLogState();
    const drifts: ContextDrift[] = [];
    // The system prompt rides `messages[0]` here, the way an OpenAI-compatible
    // body carries it: that is the hash the scheme changed.
    const messages = [
      { role: "system", content: "rules" },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ];
    const send = async () => {
      // Each call is a fresh process: the map is gone, the head file is not.
      resetWireLogState();
      const call = withWireLog(
        { sessionId: "sess-1", providerId: "legacy" },
        (async () => jsonResponse({})) as typeof globalThis.fetch,
        { onDrift: (drift) => drifts.push(drift) },
      );
      await call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    };
    const headFile = path.join(dir, "sess-1.head.json");
    const rewrite = (change: (head: Record<string, unknown>) => void) => {
      const all = JSON.parse(fs.readFileSync(headFile, "utf8"));
      change(all[Object.keys(all)[0]!]);
      fs.writeFileSync(headFile, JSON.stringify(all), "utf8");
      drifts.length = 0;
    };

    await send();

    // A head from before the `system` hash moved off `body.system`, into
    // `messages[0]` (chat 70eb2dfe: byte-identical prompt, a card saying it
    // changed entirely). Its hashes cannot be compared by this code at all.
    rewrite((head) => {
      head.scheme = 1;
      head.system = "dd29ecf524";
    });
    await send();
    expect(drifts).toEqual([]);

    // The same head under the current scheme is a comparison — the card here is
    // what proves the silence above came from the scheme, not from a head that
    // was never read at all.
    rewrite((head) => {
      head.scheme = 2;
      head.system = "dd29ecf524";
    });
    await send();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.systemChanged).toBe(true);
  });

  it("keeps the body an earlier run recorded when the counter starts over", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    resetWireLogState();
    // The restart lands in the same millisecond, which is what a suite sees: the
    // name carries the clock beside the counter, so both restart claims would
    // agree and the first body would be written over.
    vi.useFakeTimers({ now: 1_794_768_829_983, toFake: ["Date"] });
    try {
      const fetch = withWireLog(
        { sessionId: "sess-1", providerId: "legacy" },
        (async () => jsonResponse({})) as typeof globalThis.fetch,
      );
      const send = (content: string) =>
        fetch("https://relay.test/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "m", messages: [{ role: "user", content }] }),
        });

      await send("one");
      const folder = path.join(wireLogDir(), "sess-1");
      expect(fs.readdirSync(folder)).toHaveLength(1);

      // A restart on a machine whose head file is gone — the counter starts at 1
      // again, and the body of the request that already went out must survive it.
      resetWireLogState();
      fs.rmSync(path.join(wireLogDir(), "sess-1.head.json"), { force: true });
      await send("two");

      const bodies = fs.readdirSync(folder);
      expect(bodies).toHaveLength(2);
      expect(
        bodies
          .map((name) => fs.readFileSync(path.join(folder, name), "utf8"))
          .some((body) => body.includes('"one"')),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The two switches together are the promise: `full` has the bodies, the head
  // switch says a broken head is worth a record. One file per miss, holding
  // both requests whole — the reader it is written for was gluing four files by
  // hand, and after a turn of the mode switch two of them did not exist.
  it("writes one self-contained event per miss, with both requests' bodies", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    resetWireLogState();
    const drifts: ContextDrift[] = [];
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { onDrift: (drift) => drifts.push(drift), watch: () => true },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };
    const two = { role: "assistant", content: "two" };

    await send([one, two]);
    await send([one, { role: "assistant", content: "TWO" }]);

    const events = driftEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "drift",
      reason: "drift",
      seq: 2,
      prefixSame: 1,
      prevMessages: 2,
      messages: 2,
    });
    // The message the head moved at, named by role rather than by index alone.
    expect(events[0].firstDiff).toMatchObject({ index: 1, roleNext: "assistant" });
    // The previous request comes from its own file on disk, not from memory.
    expect(JSON.parse(events[0].prev.body).messages[1].content).toBe("two");
    expect(JSON.parse(events[0].body).messages[1].content).toBe("TWO");
    // And both the line and the listener point at it.
    const name = `sess-1/${fs
      .readdirSync(path.join(wireLogDir(), "sess-1"))
      .find((entry) => entry.startsWith("drift-"))}`;
    expect(lines().find((line) => line.kind === "drift")).toMatchObject({ seq: 2, driftFile: name });
    expect(drifts[0]?.driftFile).toBe(name);
  });

  it("leaves the previous head's texts out unless the head itself moved", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    resetWireLogState();
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { watch: () => true },
    );
    const messages = [{ role: "user", content: "one" }];
    const tools = [{ type: "function", function: { name: "read" } }];
    const send = (next: unknown[], withTools = tools) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: next, tools: withTools }),
      });

    await send(messages);
    // The tool list changed: that sits ahead of every message, so the file has
    // to carry both lists — the one thing that explains the miss.
    await send(messages, [{ type: "function", function: { name: "write" } }]);

    const events = driftEvents();
    expect(events).toHaveLength(1);
    expect(events[0].toolsChanged).toBe(true);
    // No message was rewritten — the head moved ahead of them — so no message
    // is named as the first difference.
    expect(events[0].firstDiff).toBeNull();
    expect(events[0].head.current.tools[0].function.name).toBe("write");
    expect(events[0].head.prev.tools[0].function.name).toBe("read");
  });

  it("writes no event when only the summary log is on", async () => {
    process.env.ACPIO_WIRE_LOG = "1";
    resetWireLogState();
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { watch: () => true },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };

    await send([one, { role: "assistant", content: "two" }]);
    await send([one, { role: "assistant", content: "TWO" }]);

    expect(driftEvents()).toEqual([]);
    expect(lines().some((line) => line.kind === "drift")).toBe(false);
  });

  it("writes no event when the head switch is off", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    resetWireLogState();
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { watch: () => false },
    );
    const one = { role: "user", content: "one" };

    await call("https://relay.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [one, { role: "assistant", content: "two" }] }),
    });
    await call("https://relay.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [one, { role: "assistant", content: "TWO" }] }),
    });

    expect(driftEvents()).toEqual([]);
  });

  it("finds the previous body after a restart, from the head file alone", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    const one = { role: "user", content: "one" };
    // Each call is a fresh process: the memory copy is gone, the head file is
    // not — and the head file is the only pointer to the body before this one.
    const send = async (messages: unknown[]) => {
      resetWireLogState();
      const call = withWireLog(
        { sessionId: "sess-1", providerId: "legacy" },
        (async () => jsonResponse({})) as typeof globalThis.fetch,
        { watch: () => true },
      );
      await call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    };

    await send([one, { role: "assistant", content: "two" }]);
    await send([one, { role: "assistant", content: "TWO" }]);

    const events = driftEvents();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].prev.body).messages[1].content).toBe("two");
  });

  it("compares a head file written before the bodies were named", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    resetWireLogState();
    const one = { role: "user", content: "one" };
    const send = async (messages: unknown[]) => {
      resetWireLogState();
      const call = withWireLog(
        { sessionId: "sess-1", providerId: "legacy" },
        (async () => jsonResponse({})) as typeof globalThis.fetch,
        { watch: () => true },
      );
      await call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    };

    await send([one, { role: "assistant", content: "two" }]);
    // What an older build left behind: the hashes are there, the new two fields
    // are not. An upgrade must not cost the chat its comparison.
    const headFile = path.join(dir, "sess-1.head.json");
    const all = JSON.parse(fs.readFileSync(headFile, "utf8")) as Record<string, any>;
    for (const key of Object.keys(all)) {
      delete all[key].bodyFile;
      delete all[key].at;
    }
    fs.writeFileSync(headFile, JSON.stringify(all), "utf8");

    await send([one, { role: "assistant", content: "TWO" }]);

    const events = driftEvents();
    expect(events).toHaveLength(1);
    // No body to hand over, and the file says so instead of inventing one.
    expect(events[0].prev).toMatchObject({ missing: true, since: "" });
  });

  it("records a miss in the compaction lane, which has no card", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    resetWireLogState();
    // The pass that squeezes the window rewrites the history; it has no drift
    // listener, and it is where a broken head costs the most.
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy", lane: "compaction" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
      { watch: () => true },
    );
    const send = (messages: unknown[]) =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      });
    const one = { role: "user", content: "one" };

    await send([one, { role: "assistant", content: "two" }]);
    await send([{ role: "user", content: "ONE" }, { role: "assistant", content: "two" }]);

    const events = driftEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ lane: "compaction", reason: "drift" });
  });

  it("records a cold miss under an intact head, without inventing bodies", async () => {
    process.env.ACPIO_WIRE_LOG = "full";
    resetWireLogState();
    const call = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () =>
        jsonResponse({
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        })) as typeof globalThis.fetch,
      { watch: () => true },
    );
    const send = () =>
      call("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "one" }],
        }),
      });

    // Byte-identical to the request before it, and the provider charged the
    // whole prompt: no diff of the two bodies can explain that, so the file
    // carries none.
    await send();
    await send();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = driftEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "provider_cold", seq: 2 });
    expect(events[0].usage).toEqual({ input: 100, cached: 0, output: 5 });
    expect(events[0].prev).toBeUndefined();
    expect(events[0].body).toBeUndefined();
  });

  it("stays silent when the switch is off", async () => {
    process.env.ACPIO_WIRE_LOG = "0";
    resetWireLogState();
    const fetch = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
    );
    await fetch("https://relay.test/v1/chat/completions", { method: "POST", body: "{}" });
    expect(fs.existsSync(path.join(wireLogDir(), "sess-1.jsonl"))).toBe(false);
  });
});

describe("sharedPrefix", () => {
  it.each([
    [["a", "b"], ["a", "b"], 2],
    [["a", "b"], ["a", "c"], 1],
    [["a"], ["b"], 0],
    [[], ["a"], 0],
    [["a"], [], 0],
  ])("%j vs %j → %i", (a, b, expected) => {
    expect(sharedPrefix(a as string[], b as string[])).toBe(expected);
  });
});
