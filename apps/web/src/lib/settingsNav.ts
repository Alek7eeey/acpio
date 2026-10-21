import type { TranslateFn } from "@acpio/i18n";

export type SettingsSection = "agent" | "builtin" | "interface";
export type SettingsAgentLeaf =
  | "connect"
  | "model"
  | "advanced"
  | "remote"
  | "diagnostics"
  | "mcp";
/** The built-in agent is a section of its own: one leaf per page of it. */
export type SettingsBuiltinLeaf =
  | "presets"
  | "generation"
  | "providers"
  | "prompt"
  | "subagents";
export type SettingsInterfaceLeaf = "appearance" | "colors" | "voice" | "chat" | "board";
export type SettingsLeaf = SettingsAgentLeaf | SettingsBuiltinLeaf | SettingsInterfaceLeaf;

/** Where a settings URL points: the section, and the leaf open inside it. */
export type SettingsLocation =
  | { section: "agent"; leaf: SettingsAgentLeaf }
  | { section: "builtin"; leaf: SettingsBuiltinLeaf }
  | { section: "interface"; leaf: SettingsInterfaceLeaf };

type TreeBranch =
  | {
      id: "agent";
      label: string;
      children: Array<{ id: SettingsAgentLeaf; label: string }>;
    }
  | {
      id: "builtin";
      label: string;
      children: Array<{ id: SettingsBuiltinLeaf; label: string }>;
    }
  | {
      id: "interface";
      label: string;
      children: Array<{ id: SettingsInterfaceLeaf; label: string }>;
    };

/**
 * The built-in agent's settings are cut into pages — one tree entry each, one
 * page each, so a group is opened instead of scrolled to. This list names
 * them: the tree's children and the pages' titles are read from the same
 * entries. Closely related knobs share a page (the context limits sit with the
 * generation knobs, the outside-the-folder switch with the skill paths it
 * governs) rather than getting a page of a row or two.
 */
const BUILTIN_LEAVES: ReadonlyArray<{ id: SettingsBuiltinLeaf; key: string }> = [
  { id: "presets", key: "settings.builtinPresetsTitle" },
  { id: "generation", key: "settings.builtinBlockGenerationContext" },
  { id: "providers", key: "settings.builtinBlockProviders" },
  { id: "prompt", key: "settings.builtinBlockPrompt" },
  { id: "subagents", key: "settings.builtinBlockSubagents" },
];

export function builtinSettingsLeaves(
  t: TranslateFn,
): Array<{ id: SettingsBuiltinLeaf; label: string }> {
  return BUILTIN_LEAVES.map(({ id, key }) => ({ id, label: t(key) }));
}

/** Title of one page of the built-in agent's section. */
export function builtinLeafLabel(t: TranslateFn, leaf: SettingsBuiltinLeaf): string {
  const entry = BUILTIN_LEAVES.find((l) => l.id === leaf);
  return entry ? t(entry.key) : leaf;
}

/**
 * Group ids the section used while its groups were headings of one page: a
 * link from back then opens the page the rows live on now.
 */
const BUILTIN_FOLDED_LEAVES: Record<string, SettingsBuiltinLeaf> = {
  context: "generation",
  access: "prompt",
};

export function getSettingsTree(t: TranslateFn): TreeBranch[] {
  const agentChildren: Array<{ id: SettingsAgentLeaf; label: string }> = [
    { id: "connect", label: t("settings.connection") },
    { id: "model", label: t("settings.modelSection") },
    { id: "advanced", label: t("settings.advanced") },
    { id: "mcp", label: t("settings.mcpTitle") },
    { id: "diagnostics", label: t("settings.diagnostics") },
    { id: "remote", label: t("settings.remoteAccess") },
  ];

  return [
    {
      id: "agent",
      label: t("settings.agents"),
      children: agentChildren,
    },
    {
      id: "builtin",
      label: t("settings.builtinTitle"),
      children: builtinSettingsLeaves(t),
    },
    {
      id: "interface",
      label: t("settings.interface"),
      children: [
        { id: "appearance", label: t("settings.appearance") },
        { id: "colors", label: t("settings.colors") },
        { id: "voice", label: t("settings.voice") },
        { id: "chat", label: t("settings.chat") },
        { id: "board", label: t("settings.board") },
      ],
    },
  ];
}

/**
 * Search terms of a whole section — what the section is about, beyond the names
 * of its leaves. Keeps the tree's filter finding a branch by the words its page
 * is introduced with (the built-in agent's, whose rows are its own leaves now).
 */
export function settingsSectionTerms(t: TranslateFn): Record<SettingsSection, string[]> {
  return {
    agent: [],
    builtin: [
      t("settings.builtinTitle"),
      t("settings.builtinDesc"),
      t("settings.builtinHint"),
      "endpoint",
      "агент",
      "agent",
    ],
    interface: [],
  };
}

export function parseSettingsSearch(search: string): SettingsLocation {
  const params = new URLSearchParams(search);
  const rawSection = params.get("section");
  const rawLeaf = params.get("leaf");
  if (rawSection === "interface") {
    const leaf: SettingsInterfaceLeaf =
      rawLeaf === "colors"
        ? "colors"
        : rawLeaf === "voice"
          ? "voice"
          : rawLeaf === "chat"
            ? "chat"
            : rawLeaf === "board"
              ? "board"
              : "appearance";
    return { section: "interface", leaf };
  }
  if (rawSection === "builtin") {
    const leaf =
      BUILTIN_LEAVES.find((l) => l.id === rawLeaf)?.id ??
      (rawLeaf ? BUILTIN_FOLDED_LEAVES[rawLeaf] : undefined) ??
      "presets";
    return { section: "builtin", leaf };
  }
  if (rawSection === "account" || rawSection === "appearance") {
    return { section: "agent", leaf: "connect" };
  }
  // The built-in agent used to be a leaf of the agent section: a link from back
  // then opens its first page instead — the same way the section params above
  // outlive the sections they named.
  if (rawLeaf === "builtin") return { section: "builtin", leaf: "presets" };

  const leaf: SettingsAgentLeaf =
    rawLeaf === "model" ||
    rawLeaf === "advanced" ||
    rawLeaf === "connect" ||
    rawLeaf === "remote" ||
    rawLeaf === "diagnostics" ||
    rawLeaf === "mcp"
      ? rawLeaf
      : "connect";
  return { section: "agent", leaf };
}

export function settingsPath(section: SettingsSection, leaf?: SettingsLeaf) {
  const params = new URLSearchParams();
  params.set("section", section);
  params.set("leaf", leaf ?? defaultLeafFor(section) ?? "connect");
  return `/settings?${params.toString()}`;
}

export function defaultLeafFor(section: SettingsSection): SettingsLeaf | undefined {
  if (section === "agent") return "connect";
  if (section === "builtin") return "presets";
  if (section === "interface") return "appearance";
  return undefined;
}
