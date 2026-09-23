// Deterministic fake ACP agent (NDJSON over stdio) for the AcpClient
// integration suite. Behavior is fixed; a few env vars switch error paths:
//   FAKE_PROMPT_ERROR=1   → session/prompt fails
//   prompt containing "EXIT-NOW" → process exits with code 1 mid-turn
//   prompt containing "SLOW-ACTIVE" → streams updates then finishes (tests timeout extend)
//   prompt containing "SLOW-SILENT" → stays quiet then finishes (tests hard timeout)
//   prompt starting with "PERMISSION:" → issues session/request_permission
//                                  and waits for the client's decision
//   prompt starting with "ELICIT:" → issues elicitation/create (form mode),
//                                  waits, then echoes the answer back
//   prompt starting with "MCP-LIST" → replies with the MCP server names the
//                                  client sent for this session (new/load/resume)
//   prompt starting with "ELICIT-DIE:" → issues elicitation/create, ends the
//                                  turn, then exits(1) before any answer
import readline from "node:readline";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "fake-model",
    options: [
      { value: "fake-model", name: "Fake Model" },
      { value: "other", name: "Other" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue: "default",
    options: [{ value: "default", name: "Default" }],
  },
];

let nextSession = 1;
const sessions = new Set();
/** sessionId → server names the client passed at new/resume/load. */
const mcpBySession = new Map();
const pending = new Map(); // requestId → { resolve }

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}
function waitForResponse(id) {
  return new Promise((resolve) => pending.set(id, { resolve }));
}

async function handle(method, params, id) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {} },
        },
        serverInfo: { name: "fake-agent", version: "1.0.0" },
      };
    case "authenticate":
      return {};
    case "session/new": {
      const sessionId = `fake-sess-${nextSession++}`;
      sessions.add(sessionId);
      if (Array.isArray(params.mcpServers)) {
        mcpBySession.set(
          sessionId,
          params.mcpServers.map((s) => String(s?.name ?? "")),
        );
      }
      return {
        sessionId,
        configOptions: structuredClone(CONFIG_OPTIONS),
        modes: { availableModes: [] },
      };
    }
    case "session/resume": {
      const sid = String(params.sessionId ?? "");
      if (!sid.startsWith("fake-sess-")) throw new Error(`ACP session not found: ${sid}`);
      if (Array.isArray(params.mcpServers)) {
        mcpBySession.set(
          sid,
          params.mcpServers.map((s) => String(s?.name ?? "")),
        );
      }
      return { configOptions: structuredClone(CONFIG_OPTIONS) };
    }
    case "session/load": {
      const sid = String(params.sessionId ?? "");
      if (!sid.startsWith("fake-sess-")) throw new Error(`ACP session not found: ${sid}`);
      if (Array.isArray(params.mcpServers)) {
        mcpBySession.set(
          sid,
          params.mcpServers.map((s) => String(s?.name ?? "")),
        );
      }
      // Per ACP: replay stored history via session/update before responding.
      notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "earlier user message" },
        },
      });
      notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m2",
          content: { type: "text", text: "earlier agent reply" },
        },
      });
      return { configOptions: structuredClone(CONFIG_OPTIONS) };
    }
    case "session/prompt": {
      if (process.env.FAKE_PROMPT_ERROR === "1") {
        throw new Error("fake prompt failure");
      }
      const text = String(params.prompt?.[0]?.text ?? "");
      if (text.includes("EXIT-NOW")) {
        process.exit(1);
      }
      if (text.includes("SLOW-ACTIVE")) {
        // Keep sending traffic past a short host timeout so the client must
        // extend the wait instead of rejecting an active turn.
        for (let i = 0; i < 6; i++) {
          await sleep(45);
          notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              messageId: `slow-${i}`,
              content: { type: "text", text: `tick ${i}` },
            },
          });
        }
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "slow-final",
            content: { type: "text", text: "slow-active done" },
          },
        });
        return { stopReason: "end_turn" };
      }
      if (text.includes("SLOW-SILENT")) {
        await sleep(250);
        return { stopReason: "end_turn" };
      }
      if (text.startsWith("ELICIT-DIE:")) {
        // Ask, complete the turn, then die before any answer arrives: the host
        // must keep the question answerable across the agent's death.
        const requestId = `elicit-die-${nextSession++}-${Date.now()}`;
        write({
          jsonrpc: "2.0",
          id: requestId,
          method: "elicitation/create",
          params: {
            sessionId: params.sessionId,
            mode: "form",
            message: text.slice("ELICIT-DIE:".length).trim(),
            requestedSchema: {
              type: "object",
              properties: { answer: { type: "string", title: "Pick one", enum: ["red", "green"] } },
              required: ["answer"],
            },
          },
        });
        setTimeout(() => process.exit(1), 150);
        return { stopReason: "end_turn" };
      }
      if (text.startsWith("MCP-LIST")) {
        const names = mcpBySession.get(String(params.sessionId ?? "")) ?? [];
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mcp-list",
            content: { type: "text", text: `mcp=${names.join(",")}` },
          },
        });
        return { stopReason: "end_turn" };
      }
      if (text.startsWith("ELICIT:")) {
        const requestId = `elicit-${nextSession++}-${Date.now()}`;
        write({
          jsonrpc: "2.0",
          id: requestId,
          method: "elicitation/create",
          params: {
            sessionId: params.sessionId,
            mode: "form",
            message: text.slice("ELICIT:".length).trim(),
            requestedSchema: {
              type: "object",
              properties: {
                answer: {
                  type: "string",
                  title: "Pick one",
                  enum: ["red", "green"],
                },
              },
              required: ["answer"],
            },
          },
        });
        const reply = await waitForResponse(requestId);
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "elicit-final",
            content: { type: "text", text: `elicitation reply: ${JSON.stringify(reply)}` },
          },
        });
        return { stopReason: "end_turn" };
      }
      if (text.startsWith("PERMISSION:")) {
        const requestId = `perm-${nextSession++}-${Date.now()}`;
        write({
          jsonrpc: "2.0",
          id: requestId,
          method: "session/request_permission",
          params: {
            sessionId: params.sessionId,
            request: { type: "request_approval", message: text.slice("PERMISSION:".length) },
          },
        });
        const decision = await waitForResponse(requestId);
        return { stopReason: "end_turn", permissionDecision: decision };
      }
      if (text.includes("PHASED")) {
        // thought → tool → thought → text: reasoning phases must stay
        // separate blocks interleaved with the tool row.
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId: "am1",
            content: { type: "text", text: "phase one thinking" },
          },
        });
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-phased-1",
            title: "search_files",
            toolName: "search_files",
            kind: "other",
            status: "pending",
          },
        });
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-phased-1",
            status: "completed",
            rawOutput: { ok: true },
          },
        });
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId: "am2",
            content: { type: "text", text: "phase two thinking" },
          },
        });
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "am3",
            content: { type: "text", text: "phased answer" },
          },
        });
        return { stopReason: "end_turn" };
      }
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "am1",
          content: { type: "text", text: "thinking hard" },
        },
      });
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "am2",
          content: { type: "text", text: `echo: ${text}` },
        },
      });
      return { stopReason: "end_turn" };
    }
    case "session/cancel":
      return {};
    case "session/set_config_option":
      return {
        configOptions: CONFIG_OPTIONS.map((o) =>
          o.id === params.configId ? { ...o, currentValue: String(params.value ?? "") } : o,
        ),
      };
    case "session/set_mode":
      return {};
    case "session/close":
      sessions.delete(params.sessionId);
      return {};
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    // A response to one of our outbound requests (e.g. permission decision).
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    entry.resolve(msg.result ?? msg.error);
    return;
  }
  if (msg.id === undefined) return; // client notification — ignore
  handle(String(msg.method ?? ""), msg.params ?? {}, msg.id)
    .then((result) => write({ jsonrpc: "2.0", id: msg.id, result }))
    .catch((err) =>
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      }),
    );
});
