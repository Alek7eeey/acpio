// Drivers for the spawn-based harnesses. Both print one JSON event per line in
// `--mode json`, so the metrics come from the same parser. `omp` is a pi fork:
// same event names, different CLI surface. `opencode` prints its own
// `run --format json` envelope (see summarizeOpenCodeStream).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarizeAgentOutput } from "./jsonl.mjs";
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

/**
 * opencode ships as a self-contained native binary behind an npm shim. On
 * Windows that shim is a shell script, which node's shell-less spawn cannot
 * exec — resolve the package's own bin (the file the shim points at).
 */
export function opencodeCommand() {
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) return { cmd: explicit, prefix: [] };
  const guess = path.join(process.env.APPDATA || "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  if (existsSync(guess)) return { cmd: guess, prefix: [] };
  return { cmd: "opencode", prefix: [] };
}

/**
 * Stage the opencode config a bench rollout needs: one custom provider wired to
 * the labelled proxy URL, the model under test, and the gateway's session
 * header (zen answers every request without it with MissingSessionID — a
 * stable per-pair id is also the cache/routing key the gateway keys on).
 * The config lives in the bench's own dir, never the user's ~/.config/opencode.
 */
export function ensureOpenCodeConfig(dir, { provider, baseUrl, apiKey, modelId, contextWindow, sessionId }) {
  mkdirSync(dir, { recursive: true });
  for (const sub of ["data", "state", "cache", "run"]) mkdirSync(path.join(dir, sub), { recursive: true });
  const file = path.join(dir, "opencode.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: `${provider}/${modelId}`,
        provider: {
          [provider]: {
            name: provider,
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: baseUrl,
              apiKey,
              headers: { "x-opencode-session": sessionId },
            },
            models: {
              [modelId]: { name: modelId, limit: { context: contextWindow, output: 16384 } },
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  return file;
}

/**
 * Everything opencode reads comes from the staged dir: config, XDG data/state/
 * cache/runtime (sessions, db, logs) and no project config from the fixture —
 * a run must not depend on, or mutate, the machine's real opencode setup.
 */
export function opencodeEnv(dir) {
  return {
    OPENCODE_CONFIG: path.join(dir, "opencode.json"),
    OPENCODE_CONFIG_DIR: dir,
    XDG_DATA_HOME: path.join(dir, "data"),
    XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_RUNTIME_DIR: path.join(dir, "run"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}

export const ompProfile = () => process.env.OMP_PROFILE || "omp-bench";

/**
 * omp only knows custom providers from its profile's `models.yml`. Write the
 * bench provider there once — never touch the user's default profile.
 * `baseDir` relocates the profiles root (the SWE runner stages configs for
 * docker cp instead of using the host home).
 */
export function ensureOmpModel(profile, { provider, baseUrl, apiKey, modelId, contextWindow }, baseDir = path.join(os.homedir(), ".omp", "profiles")) {
  const dir = path.join(baseDir, profile, "agent");
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

/**
 * pi reads custom providers from `<configDir>/models.json`. The bench points
 * pi at its own config dir (`PI_CODING_AGENT_DIR`) instead of `~/.pi/agent`, so
 * a run never depends on - or mutates - the user's real provider list.
 */
export function ensurePiModel(configDir, { provider, baseUrl, apiKey, modelId, contextWindow }) {
  mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "models.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        providers: {
          [provider]: {
            baseUrl,
            api: "openai-completions",
            apiKey,
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [{ id: modelId, contextWindow }],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  // pi's bash tool has no default per-command timeout ("timeout in seconds,
  // optional"), so one hung command used to burn the whole rollout budget
  // (sphinx-10673: `git log -S --all`, 45 minutes). The extension gives every
  // bash call the same 120s ceiling the builtin agent enforces; the model can
  // still pass a larger explicit timeout when a command legitimately needs it.
  const extensionsDir = path.join(configDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(
    path.join(extensionsDir, "bash-timeout.js"),
    `// Default per-command ceiling for the bash tool, injected by the bench.
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && event.input.timeout == null) {
      event.input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
    }
  });
}
`,
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
  if (agent === "opencode") {
    return [
      "run",
      "--standalone", // private server per rollout, no shared background service
      "--auto", // auto-approve permissions (the bench sandbox is the permission)
      "--format",
      "json",
      "-m",
      `${provider}/${modelId}`,
      prompt,
    ];
  }
  throw new Error(`unknown cli agent: ${agent}`);
}

export function agentCommand(agent) {
  if (agent === "pi") return piCommand();
  if (agent === "omp") return ompCommand();
  if (agent === "opencode") return opencodeCommand();
  throw new Error(`unknown cli agent: ${agent}`);
}

export async function runCliAgent(agent, { task, ws, provider, modelId, timeoutMs, piConfigDir, opencodeConfigDir }) {
  const { cmd, prefix } = agentCommand(agent);
  const args = [...prefix, ...agentArgs(agent, { prompt: task.prompt, provider, modelId })];
  const env =
    agent === "pi" && piConfigDir
      ? { PI_CODING_AGENT_DIR: piConfigDir, PI_OFFLINE: "1" }
      : agent === "opencode" && opencodeConfigDir
        ? opencodeEnv(opencodeConfigDir)
        : undefined;
  const res = await runProcess(cmd, args, { cwd: ws, timeoutMs, env });
  const summary = summarizeAgentOutput(agent, res.stdout);
  return {
    ...summary,
    wallMs: res.wallMs,
    exitCode: res.code,
    timedOut: res.timedOut,
    stderrTail: res.stderr.trim().slice(-1500),
  };
}
