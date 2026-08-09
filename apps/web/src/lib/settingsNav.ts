import type { TranslateFn } from "@acprocess/i18n";

export type SettingsSection = "agent" | "gitea";
export type SettingsAgentLeaf = "connect" | "model" | "advanced" | "remote";
export type SettingsLeaf = SettingsAgentLeaf;

type TreeBranch =
  | {
      id: "agent";
      label: string;
      children: Array<{ id: SettingsAgentLeaf; label: string }>;
    }
  | {
      id: "gitea";
      label: string;
      children: Array<{ id: SettingsLeaf; label: string }>;
    };

export function getSettingsTree(t: TranslateFn): TreeBranch[] {
  return [
    {
      id: "agent",
      label: t("settings.agents"),
      children: [
        { id: "connect", label: t("settings.connection") },
        { id: "model", label: t("settings.modelSection") },
        { id: "advanced", label: t("settings.advanced") },
        { id: "remote", label: t("settings.remoteAccess") },
      ],
    },
    {
      id: "gitea",
      label: t("common.gitea"),
      children: [],
    },
  ];
}

export function parseSettingsSearch(search: string): {
  section: SettingsSection;
  leaf: SettingsLeaf;
} {
  const params = new URLSearchParams(search);
  const rawSection = params.get("section");
  if (rawSection === "account" || rawSection === "appearance") {
    return { section: "agent", leaf: "connect" };
  }

  const rawLeaf = params.get("leaf");
  const leaf: SettingsAgentLeaf =
    rawLeaf === "model" ||
    rawLeaf === "advanced" ||
    rawLeaf === "connect" ||
    rawLeaf === "remote"
      ? rawLeaf
      : "connect";
  return { section: "agent", leaf };
}

export function settingsPath(section: SettingsSection, leaf?: SettingsLeaf) {
  const safeSection = section === "gitea" ? "agent" : section;
  const params = new URLSearchParams();
  params.set("section", safeSection);
  if (safeSection === "agent") params.set("leaf", leaf ?? "connect");
  return `/settings?${params.toString()}`;
}

export function defaultLeafFor(section: SettingsSection): SettingsLeaf | undefined {
  if (section === "agent") return "connect";
  return undefined;
}
