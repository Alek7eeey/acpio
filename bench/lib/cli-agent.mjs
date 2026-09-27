// Drivers for the spawn-based harnesses. Both print one JSON event per line in
// `--mode json`, so the metrics come from the same parser. `omp` is a pi fork:
// same event names, different CLI surface.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarizeAgentStream } from "./jsonl.mjs";
import { runProcess } from "./util.mjs";

/** pi's npm shim is a `.cmd`; its node entry spawns cleanly without a shell. */
export function piCommand() {
  const explicit = process.env.PI_CLI;
  if (explicit) return { cmd: process.execPath, prefix: [explicit] };
  const guess = path.join(
    process.env.APPDATA || "",
    "npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
  if (existsSync(guess)) return { cmd: process.execPath, prefix: [guess] };
  return { cmd: "pi", prefix: [] };
}

export function ompCommand() {
  return { cmd: process.env.OMP_BIN || "omp", prefix: [] };
}

export const ompProfile = () => process.env.OMP_PROFILE || "omp-bench";

/**
 * omp only knows custom providers from its profile's `models.yml`. Write the
 * bench provider there once — never touch the user's default profile.
 */
export function ensureOmpModel(profile, { provider, baseUrl, apiKey, modelId, contextWindow }) {
  const dir = path.join(os.homedir(), ".omp", "profiles", profile, "agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "models.yml");
  writeFileSync(
    file,
    [
      "providers:",
      `  ${provider}:`,
      `    baseUrl: ${baseUrl}`,
      `    apiKey: ${apiKey}`,
      "    api: openai-completions",
      "    auth: apiKey",
      "    models:",
      `      - id: ${modelId}`,
      `        name: ${modelId}`,
      `        contextWindow: ${contextWindow}`,
      "",
    ].join("\n"),
  );
  return file;
}

const PI_ISOLATION = [
  "--no-session",
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--offline",
];
const OMP_ISOLATION = ["--no-extensions", "--no-skills", "--no-rules"];

/** Args a driver should run; exported so `--print-command` can show them. */
export function agentArgs(agent, { prompt, provider, modelId }) {
  if (agent === "pi") {
    return [
      "-p",
      "--mode",
      "json",
      ...PI_ISOLATION,
      "--provider",
      provider,
      "--model",
      modelId,
      prompt,
    ];
  }
  if (agent === "omp") {
    return [
      "--profile",
      ompProfile(),
      "--mode=json",
      "-p",
      "--no-session",
      "--no-title",
      "--auto-approve",
      ...OMP_ISOLATION,
      "--model",
      `${provider}/${modelId}`,
      prompt,
    ];
  }
  throw new Error(`unknown cli agent: ${agent}`);
}

export function agentCommand(agent) {
  if (agent === "pi") return piCommand();
  if (agent === "omp") return ompCommand();
  throw new Error(`unknown cli agent: ${agent}`);
}

export async function runCliAgent(agent, { task, ws, provider, modelId, timeoutMs }) {
  const { cmd, prefix } = agentCommand(agent);
  const args = [...prefix, ...agentArgs(agent, { prompt: task.prompt, provider, modelId })];
  const res = await runProcess(cmd, args, { cwd: ws, timeoutMs });
  const summary = summarizeAgentStream(res.stdout);
  return {
    ...summary,
    wallMs: res.wallMs,
    exitCode: res.code,
    timedOut: res.timedOut,
    stderrTail: res.stderr.trim().slice(-1500),
  };
}
