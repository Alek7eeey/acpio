import type { TranslateFn } from "@acprocess/i18n";

export type SettingsSection = "agent" | "interface";
export type SettingsAgentLeaf =
  | "connect"
  | "model"
  | "advanced"
  | "remote"
  | "diagnostics"
  | "mcp";
export type SettingsInterfaceLeaf = "appearance" | "colors" | "voice" | "chat";
export type SettingsLeaf = SettingsAgentLeaf | SettingsInterfaceLeaf;

type TreeBranch =
  | {
      id: "agent";
      label: string;
      children: Array<{ id: SettingsAgentLeaf; label: string }>;
    }
  | {
      id: "interface";
      label: string;
      children: Array<{ id: SettingsInterfaceLeaf; label: string }>;
    };

export function getSettingsTree(t: TranslateFn): TreeBranch[] {
  const children: Array<{ id: SettingsAgentLeaf; label: string }> = [
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
      children,
    },
    {
      id: "interface",
      label: t("settings.interface"),
      children: [
        { id: "appearance", label: t("settings.appearance") },
        { id: "colors", label: t("settings.colors") },
        { id: "voice", label: t("settings.voice") },
        { id: "chat", label: t("settings.chat") },
      ],
    },
  ];
}

export function parseSettingsSearch(search: string): {
  section: SettingsSection;
  leaf: SettingsLeaf;
} {
  const params = new URLSearchParams(search);
  const rawSection = params.get("section");
  if (rawSection === "interface") {
    const rawLeaf = params.get("leaf");
    const leaf: SettingsInterfaceLeaf =
      rawLeaf === "colors" ? "colors" : rawLeaf === "voice" ? "voice" : rawLeaf === "chat" ? "chat" : "appearance";
    return { section: "interface", leaf };
  }
  if (rawSection === "account" || rawSection === "appearance") {
    return { section: "agent", leaf: "connect" };
  }

  const rawLeaf = params.get("leaf");
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
  if (section === "interface") return "appearance";
  return undefined;
}
