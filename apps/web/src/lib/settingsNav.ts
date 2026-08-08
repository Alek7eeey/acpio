import type { TranslateFn } from "@acprocess/i18n";

export type SettingsSection = "agent" | "account" | "gitea";
export type SettingsAgentLeaf = "connect" | "model" | "advanced";
export type SettingsAccountLeaf = "profile";
export type SettingsLeaf = SettingsAgentLeaf | SettingsAccountLeaf;

type TreeBranch =
  | {
      id: "agent";
      label: string;
      children: Array<{ id: SettingsAgentLeaf; label: string }>;
    }
  | {
      id: "account";
      label: string;
      children: Array<{ id: SettingsAccountLeaf; label: string }>;
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
      ],
    },
    {
      id: "account",
      label: t("settings.general"),
      children: [{ id: "profile", label: t("settings.profile") }],
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
  const section: SettingsSection =
    rawSection === "account" || rawSection === "appearance" ? "account" : "agent";

  if (section === "account") {
    return { section, leaf: "profile" };
  }

  const rawLeaf = params.get("leaf");
  const leaf: SettingsAgentLeaf =
    rawLeaf === "model" || rawLeaf === "advanced" || rawLeaf === "connect" ? rawLeaf : "connect";
  return { section, leaf };
}

export function settingsPath(section: SettingsSection, leaf?: SettingsLeaf) {
  const safeSection = section === "gitea" ? "agent" : section;
  const params = new URLSearchParams();
  params.set("section", safeSection);
  if (safeSection === "agent") params.set("leaf", leaf ?? "connect");
  if (safeSection === "account") params.set("leaf", "profile");
  return `/settings?${params.toString()}`;
}

export function defaultLeafFor(section: SettingsSection): SettingsLeaf | undefined {
  if (section === "agent") return "connect";
  if (section === "account") return "profile";
  return undefined;
}
