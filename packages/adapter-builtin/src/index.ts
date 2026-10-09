import type { HarnessAdapter } from "@acpio/shared";
import { createBuiltinTransport } from "./agent.js";
import { hasBuiltinEndpoint } from "./config.js";

/**
 * Where a session's offloaded results are archived. The host has to allow reads
 * from that folder — the archived bytes are fetched back with `read` — so the
 * layout is exported rather than written down twice.
 */
export { offloadDir } from "./offload.js";

/**
 * Model resolution over the Settings → Built-in agent rows. The server needs it
 * outside the agent too: a title generated for a chat picks its model the same
 * way the agent picks its own — a stored value, then the default, then the
 * first configured row.
 */
export {
  builtinModelOptions,
  hasBuiltinEndpoint,
  initialModelId,
  resolveBuiltinModel,
  type BuiltinModelSelection,
} from "./config.js";

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

  // Exposes `thinking` (Default/Low/Off) as a separate config option per model,
  // so the composer renders it as a chip and the ⋯ flyout — same shape omp's
  // CLI advertises.
  parameterizedModelPicker: true,
  subagentStreaming: false,
  cloudCatalog: false,
  // The loop is ours: `prepareStep` folds a mid-turn message into the next
  // model call, so this harness is the one that honours `afterStep`.
  midTurnSteering: true,
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
