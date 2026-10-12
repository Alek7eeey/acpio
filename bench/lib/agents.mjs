// The `--agents` grammar, shared by bench/run.mjs and bench/swe/run-swe.mjs:
// the label a harness is reported (and labelled on the wire) under, the driver
// that actually runs it, and the knobs that make a built-in *variant*. One
// copy, so the two runners can never drift into accepting different spellings
// of the same thing — the SWE table and the task table have to line up.

//
// Built-in variants: the same shipped agent with one of its own thinking knobs
// pinned, so a run compares configurations of one harness instead of its
// average. `-low` / `-extra-low` is the ⋯ menu's per-chat "Thinking" mode (a
// model param, pinned per provider in settings); `-with-thinking-limit-N` adds
// the fuse that cuts one step's overlong reasoning (`builtinThinkingLimit`);
// `-with-reasoning-effort-<level>` pins the provider's extra request body,
// which is the wire knob the CLI harnesses set on their own (`omp` sends
// `reasoning_effort: "high"` on every call) — the prompt-level Thinking mode
// never reaches the endpoint, so without this a variant cannot be compared
// against a CLI harness on equal terms.
const BUILTIN_VARIANT_RE =
  /^builtin(?:-(low|extra-low))?(?:-with-thinking-limit-(\d+))?(?:-with-reasoning-effort-([a-z]+))?$/;

/** `--agents` entries → { name (label and wire), base (driver), knobs }. */
export function parseAgents(names) {
  return names.map((name) => {
    const variant = BUILTIN_VARIANT_RE.exec(name);
    if (variant) {
      return {
        name,
        base: "builtin",
        thinking: variant[1] ?? null,
        thinkingLimit: variant[2] ? Number(variant[2]) : null,
        reasoningEffort: variant[3] ?? null,
      };
    }
    if (name === "pi" || name === "omp" || name === "opencode") {
      return { name, base: name, thinking: null, thinkingLimit: null, reasoningEffort: null };
    }
    throw new Error(
      `unknown agent "${name}" — known: pi, omp, opencode, builtin[-low|-extra-low][-with-thinking-limit-<chars>][-with-reasoning-effort-<level>]`,
    );
  });
}

/**
 * What a built-in *variant* pins on the server, plus the provider `body` for
 * `-with-reasoning-effort-<level>`. One copy, so every runner that can start a
 * variant writes the same knobs: the host loop, the daily docker runner and the
 * SWE runner all drive the same server-side switches.
 *
 * `modelValue` is the caller's `builtinModelValue(provider, modelId)`: the
 * server only hands `modelParams` to the agent alongside a model, so the model
 * is pinned too — without it the boot's model step bails out before the params
 * and the variant would silently be plain `builtin`. Both knobs are always
 * written, because a slot serves several variants in turn: "no knob" has to
 * reset the slot instead of inheriting the previous pair's mode.
 */
export function builtinVariantKnobs(agent, { modelValue }) {
  return {
    /** Spread into the provider entry; `null` when the variant pins no body. */
    providerBody: agent.reasoningEffort
      ? JSON.stringify({ reasoning_effort: agent.reasoningEffort })
      : null,
    settings: {
      defaultModelByProvider: { builtin: modelValue },
      defaultModelParamsByProvider: { builtin: { thinking: agent.thinking ?? "default" } },
      builtinThinkingLimit: agent.thinkingLimit ?? 0,
    },
  };
}

/**
 * Knobs the server quietly dropped, as sentences to log. A variant whose fuse or
 * request body never reached the wire is not that variant, and finding out at
 * analysis time costs the whole run — so each runner says it on the spot.
 */
export function builtinVariantWarnings(agent, applied) {
  const out = [];
  if (agent.thinkingLimit !== null && applied?.builtinThinkingLimit !== agent.thinkingLimit) {
    out.push(`thinking limit ${agent.thinkingLimit} did not stick (server reports ${applied?.builtinThinkingLimit})`);
  }
  const body = applied?.builtinProviders?.[0]?.body;
  if (agent.reasoningEffort) {
    const want = JSON.stringify({ reasoning_effort: agent.reasoningEffort });
    if (body !== want) out.push(`reasoning effort ${agent.reasoningEffort} did not stick (server reports ${JSON.stringify(body)})`);
  }
  return out;
}
