import { describe, it, expect } from "vitest";
import type { AdapterMetaDto } from "@acpio/shared";
import { isAgentUsable, pickCreateProvider, usableAgentIds } from "./harness";

function adapter(id: string, label: string, family?: string): AdapterMetaDto {
  return {
    id,
    label,
    enabled: true,
    ...(family ? { family: family as AdapterMetaDto["family"] } : {}),
    commandField: "",
    argsField: "",
    defaultCommand: "",
    defaultArgs: [],
    installHint: "",
    restoreMode: "resume",
    parameterizedModelPicker: false,
    subagentStreaming: false,
    cloudCatalog: false,
    midTurnSteering: false,
    defaultModes: [],
    subagentToolKinds: [],
  };
}

const BUILTIN = adapter("builtin", "Built-in");
const PRESET = adapter("builtin-fast", "Built-in (Fast)", "builtin");
const OMP = adapter("omp", "OMP CLI");
const CURSOR = adapter("cursor", "Cursor CLI");

describe("a new chat's agent", () => {
  it("is the built-in agent when it is the only harness configured, endpoint or not", () => {
    // The built-in agent runs inside the server, so a probe says `false` only
    // while it lacks an endpoint — which the composer names when a prompt is
    // sent. Asking the probe here left the new-chat path dead ("no agents
    // available") while the board kept creating tasks on the same agent.
    expect(pickCreateProvider({ builtin: false }, [BUILTIN])).toBe("builtin");
    expect(pickCreateProvider({}, [BUILTIN, PRESET])).toBe("builtin");
    expect(usableAgentIds({ builtin: false }, [BUILTIN, PRESET])).toEqual([
      "builtin",
      "builtin-fast",
    ]);
    expect(isAgentUsable({ builtin: false }, [BUILTIN], "builtin")).toBe(true);
  });

  it("still prefers a probed harness over the built-in one, and the default over both", () => {
    const adapters = [BUILTIN, OMP];
    expect(pickCreateProvider({ omp: true }, adapters)).toBe("omp");
    expect(pickCreateProvider({ omp: true }, adapters, "builtin")).toBe("builtin");
    expect(pickCreateProvider({ omp: true, builtin: false }, adapters, "cursor")).toBe("omp");
  });

  it("is nothing at all when every external harness is offline and the built-in one is off", () => {
    expect(pickCreateProvider({ omp: false }, [OMP, CURSOR])).toBeNull();
    expect(isAgentUsable({ omp: false }, [OMP], "omp")).toBe(false);
  });
});
