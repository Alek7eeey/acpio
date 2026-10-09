import { describe, it, expect, vi } from "vitest";
import {
  defaultLeafFor,
  getSettingsTree,
  parseSettingsSearch,
  settingsPath,
} from "./settingsNav";
import type { SettingsSection } from "./settingsNav";

/** Stub translator that echoes the message key. */
const t = (key: string) => key;

describe("parseSettingsSearch", () => {
  it.each(["connect", "model", "builtin", "advanced", "remote", "diagnostics", "mcp"] as const)(
    "parses the agent leaf %j",
    (leaf) => {
      expect(parseSettingsSearch(`?section=agent&leaf=${leaf}`)).toEqual({
        section: "agent",
        leaf,
      });
    },
  );

  it.each(["appearance", "colors", "voice", "chat"] as const)(
    "parses the interface leaf %j",
    (leaf) => {
      expect(parseSettingsSearch(`?section=interface&leaf=${leaf}`)).toEqual({
        section: "interface",
        leaf,
      });
    },
  );

  it("defaults an unknown agent leaf to connect", () => {
    expect(parseSettingsSearch("?section=agent&leaf=wat")).toEqual({
      section: "agent",
      leaf: "connect",
    });
  });

  it("defaults an interface-only leaf under section=agent to connect", () => {
    expect(parseSettingsSearch("?section=agent&leaf=colors")).toEqual({
      section: "agent",
      leaf: "connect",
    });
  });

  it("defaults an agent-only leaf under section=interface to appearance", () => {
    expect(parseSettingsSearch("?section=interface&leaf=model")).toEqual({
      section: "interface",
      leaf: "appearance",
    });
  });

  it("defaults an unknown interface leaf to appearance", () => {
    expect(parseSettingsSearch("?section=interface&leaf=wat")).toEqual({
      section: "interface",
      leaf: "appearance",
    });
  });

  it("defaults to the agent section with connect when no params are present", () => {
    expect(parseSettingsSearch("")).toEqual({ section: "agent", leaf: "connect" });
  });

  it("maps the legacy account section to agent/connect", () => {
    expect(parseSettingsSearch("?section=account")).toEqual({
      section: "agent",
      leaf: "connect",
    });
    expect(parseSettingsSearch("?section=account&leaf=voice")).toEqual({
      section: "agent",
      leaf: "connect",
    });
  });

  it("maps the legacy appearance section to agent/connect", () => {
    expect(parseSettingsSearch("?section=appearance")).toEqual({
      section: "agent",
      leaf: "connect",
    });
  });

  it("defaults an unknown section to agent/connect", () => {
    expect(parseSettingsSearch("?section=unknown")).toEqual({
      section: "agent",
      leaf: "connect",
    });
  });

  it("matches sections exactly rather than case-insensitively", () => {
    expect(parseSettingsSearch("?section=INTERFACE&leaf=colors")).toEqual({
      section: "agent",
      leaf: "connect",
    });
    expect(parseSettingsSearch("?section=AGENT&leaf=model")).toEqual({
      section: "agent",
      leaf: "model",
    });
  });

  it("honors a leaf even when the section param is missing", () => {
    expect(parseSettingsSearch("?leaf=model")).toEqual({
      section: "agent",
      leaf: "model",
    });
  });

  it("ignores unrelated extra params", () => {
    expect(parseSettingsSearch("?section=interface&leaf=voice&extra=1")).toEqual({
      section: "interface",
      leaf: "voice",
    });
  });
});

describe("settingsPath", () => {
  it("defaults the agent leaf to connect", () => {
    expect(settingsPath("agent")).toBe("/settings?section=agent&leaf=connect");
  });

  it("uses the given agent leaf", () => {
    expect(settingsPath("agent", "model")).toBe("/settings?section=agent&leaf=model");
  });

  it("defaults the interface leaf to appearance", () => {
    expect(settingsPath("interface")).toBe("/settings?section=interface&leaf=appearance");
  });

  it("uses the given interface leaf", () => {
    expect(settingsPath("interface", "voice")).toBe("/settings?section=interface&leaf=voice");
  });

  it.each(["connect", "model", "builtin", "advanced", "remote", "diagnostics", "mcp"] as const)(
    "round-trips the agent leaf %j",
    (leaf) => {
      const path = settingsPath("agent", leaf);
      expect(parseSettingsSearch(path.slice(path.indexOf("?")))).toEqual({
        section: "agent",
        leaf,
      });
    },
  );

  it.each(["appearance", "colors", "voice", "chat"] as const)(
    "round-trips the interface leaf %j",
    (leaf) => {
      const path = settingsPath("interface", leaf);
      expect(parseSettingsSearch(path.slice(path.indexOf("?")))).toEqual({
        section: "interface",
        leaf,
      });
    },
  );
});

describe("defaultLeafFor", () => {
  it("returns connect for the agent section", () => {
    expect(defaultLeafFor("agent")).toBe("connect");
  });

  it("returns appearance for the interface section", () => {
    expect(defaultLeafFor("interface")).toBe("appearance");
  });

  it("returns undefined for an unknown section", () => {
    expect(defaultLeafFor("other" as SettingsSection)).toBeUndefined();
  });
});

describe("getSettingsTree", () => {
  it("builds the agent branch with its id and translated label", () => {
    const tree = getSettingsTree(t);
    expect(tree[0].id).toBe("agent");
    expect(tree[0].label).toBe("settings.agents");
  });

  it("lists the agent children in source order with their labels", () => {
    const tree = getSettingsTree(t);
    expect(tree[0].children.map((c) => c.id)).toEqual([
      "connect",
      "model",
      "builtin",
      "advanced",
      "mcp",
      "diagnostics",
      "remote",
    ]);
    expect(tree[0].children.map((c) => c.label)).toEqual([
      "settings.connection",
      "settings.modelSection",
      "settings.builtinTitle",
      "settings.advanced",
      "settings.mcpTitle",
      "settings.diagnostics",
      "settings.remoteAccess",
    ]);
  });

  it("builds the interface branch with its id and translated labels", () => {
    const tree = getSettingsTree(t);
    expect(tree[1].id).toBe("interface");
    expect(tree[1].label).toBe("settings.interface");
    expect(tree[1].children.map((c) => c.id)).toEqual([
      "appearance",
      "colors",
      "voice",
      "chat",
    ]);
    expect(tree[1].children.map((c) => c.label)).toEqual([
      "settings.appearance",
      "settings.colors",
      "settings.voice",
      "settings.chat",
    ]);
  });

  it("translates every node label through the given t function", () => {
    const spy = vi.fn((key: string) => key);
    const tree = getSettingsTree(spy);
    const allLabels = [
      tree[0].label,
      ...tree[0].children.map((c) => c.label),
      tree[1].label,
      ...tree[1].children.map((c) => c.label),
    ];
    expect(spy).toHaveBeenCalledTimes(allLabels.length);
    for (const key of allLabels) {
      expect(spy).toHaveBeenCalledWith(key);
    }
  });

  it("returns exactly two branches", () => {
    expect(getSettingsTree(t)).toHaveLength(2);
  });
});
