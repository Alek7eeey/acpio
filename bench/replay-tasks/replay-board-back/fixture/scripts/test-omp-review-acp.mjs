import { spawn } from "node:child_process";
import readline from "node:readline";

const cwd = "E:/share/acprocess";
const child = spawn("omp", ["acp"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});

let id = 0;
const pending = new Map();
let stderr = "";

child.stderr.on("data", (buf) => {
  stderr += buf.toString();
});

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("OUT", line.slice(0, 200));
    return;
  }
  if (msg.method === "elicitation/create") {
    const schema = msg.params?.requestedSchema ?? {};
    const props = schema.properties ?? {};
    console.log("\n--- ELICITATION ---");
    console.log("message:", msg.params?.message);
    console.log("properties:", JSON.stringify(props, null, 2));
    const answers = {};
    for (const [key, prop] of Object.entries(props)) {
      if (key.endsWith("__other")) continue;
      const p = prop ?? {};
      const pick =
        Array.isArray(p.enum) && p.enum.length
          ? p.enum[0]
          : Array.isArray(p.oneOf) && p.oneOf.length
            ? p.oneOf[0]?.const ?? p.oneOf[0]?.title
            : undefined;
      if (pick !== undefined) answers[key] = pick;
      else if (p.type === "boolean") answers[key] = true;
      else if (p.type === "string") answers[key] = "";
    }
    console.log("auto-answer:", answers);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { action: "accept", content: answers },
      }) + "\n",
    );
    return;
  }
  if (msg.method) {
    console.log("NOTIFY", msg.method);
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});

function send(method, params) {
  return new Promise((resolve, reject) => {
    const rid = ++id;
    pending.set(rid, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout ${method}`)), 180_000);
  });
}

try {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test", version: "0" },
  });
  const sess = await send("session/new", { cwd, mcpServers: [] });
  console.log("session", sess.sessionId);
  const result = await send("session/prompt", {
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: "/review" }],
  });
  console.log("\nPROMPT RESULT", result);
  console.log("\nSTDERR TAIL\n", stderr.slice(-4000));
} catch (e) {
  console.error("FAIL", e);
  console.error("\nSTDERR TAIL\n", stderr.slice(-4000));
} finally {
  child.kill();
}
