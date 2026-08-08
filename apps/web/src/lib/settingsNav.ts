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

export const SETTINGS_TREE: TreeBranch[] = [
  {
    id: "agent",
    label: "Агенты",
    children: [
      { id: "connect", label: "Подключение" },
      { id: "model", label: "Модель" },
      { id: "advanced", label: "Дополнительно" },
    ],
  },
  {
    id: "account",
    label: "Общее",
    children: [{ id: "profile", label: "Профиль" }],
  },
  {
    id: "gitea",
    label: "Gitea",
    children: [],
  },
];

export function parseSettingsSearch(search: string): {
  section: SettingsSection;
  leaf: SettingsLeaf;
} {
  const params = new URLSearchParams(search);
  const rawSection = params.get("section");
  // Gitea settings are temporarily disabled; appearance/password → account/profile
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
