import type { HarnessAdapter } from "@acpio/shared";
import { createBuiltinTransport } from "./agent.js";
import { hasBuiltinEndpoint } from "./config.js";

/**
 * Built-in harness: the agent runs inside the server instead of being spawned,
 * so there is no CLI to install and no `command`/`args` to configure. Everything
 * user-facing lives in Settings → Built-in agent: one or more OpenAI-compatible
 * providers, each with its own endpoint, key and model list.
 */
export const builtinAdapter: HarnessAdapter = {
  id: "builtin",
  label: "Built-in",
  descriptionKey: "settings.builtinDesc",

  // No binary: `createTransport` replaces the spawn path entirely.
  commandField: "",
  argsField: "",
  // API keys belong to each provider row, not to one settings field.
  apiKeyField: "",
  defaultCommand: "",
  defaultArgs: [],
  binaryNames: [],
  binaryDirs: [],
  installHint: "",
  createTransport: createBuiltinTransport,

  // Without an endpoint the agent boots but has nothing to talk to — every
  // prompt would die on model selection, so the probe must say offline.
  unavailableReason: (settings) =>
    hasBuiltinEndpoint(settings)
      ? null
      : settings.locale === "ru"
        ? "Укажите endpoint в Settings → Agents → Built-in agent — агенту не к чему подключиться."
        : "Set an endpoint in Settings → Agents → Built-in agent — there is nothing to connect to.",

  restoreMode: "load",
  suppressReplayOnLoad: true,

  parameterizedModelPicker: false,
  subagentStreaming: false,
  cloudCatalog: false,
  defaultModes: [
    { value: "agent", name: "Agent" },
    { value: "plan", name: "Plan" },
    { value: "ask", name: "Ask" },
  ],
  subagentToolKinds: [],
  extensionKinds: {},

  requestKinds: {
    "session/request_permission": "permission",
  },
};
