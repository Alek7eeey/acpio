import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CHAT_TREE_RECENT_LIMIT_MAX,
  CUSTOM_AGENT_ID_RE,
  DEFAULT_CHAT_CHIP_OPTIONS,
  migrateModelParamValues,
  mergeChatChipOptions,
  normalizeChatTreeRecentLimit,
  normalizeCustomAgentId,
  normalizeCustomAgents,
  SHELL_SESSION_PROVIDER,
  type AdapterMetaDto,
  type AdapterRestoreMode,
  type AgentProvider,
  type AppSettings,
  type AttachSource,
  type BuiltinProviderConfig,
  type ChatActionId,
  type ChatComposerButtonId,
  type ChatHeaderIconId,
  type ChatMetaChipId,
  type ChatTreeElementId,
  type ChatTreeMenuId,
  type CustomAgentSpec,
  type DiagnosticsDumpMeta,
  type McpServerConfig,
  type ModelOption,
  type ModelParamDto,
  DEFAULT_MCP_PROJECT_FILES,
  DEFAULT_BUILTIN_SKILL_PATHS,
  mcpServerEndpoint,
  pushRecentModel,
} from "@acpio/shared";
import { formatArgs, formatEnvLines, parseEnvLines, splitArgs } from "../lib/argsInput";
import { api } from "../lib/api";
import { getSettingsTree, parseSettingsSearch, settingsPath, type SettingsSection, type SettingsLeaf } from "../lib/settingsNav";
import { highlightText, matchAny, SearchGate, SettingsSearchProvider, settingsSearchIndex } from "../lib/settingsSearch";
import { useT } from "../lib/i18n";
import { cachedModelsFor, useAppStore } from "../lib/store";
import { ModelPicker } from "../components/ModelPicker";
import { BuiltinHeadersEditor } from "../components/BuiltinHeadersEditor";
import { BuiltinModelsEditor } from "../components/BuiltinModelsEditor";
import { OptionPicker } from "../components/OptionPicker";
import { ServerFolderBrowseDialog } from "../components/ServerFolderBrowseDialog";
import { SettingRow, SettingTable, Toggle } from "../components/SettingRow";
import { ChatSettingsPreview } from "../components/ChatSettingsPreview";
import { MiddleTruncate } from "../components/MiddleTruncate";
import { getDiagnosticsDump, submitDiagnosticsDump } from "../lib/diagnostics";
import { startReadAloud, stopReadAloud } from "../lib/tts";
import { applyAppearance } from "../lib/appearance";
import { DARK_SCHEMES, LIGHT_SCHEMES, SYSTEM_SWATCH } from "../lib/themeSchemes";
import { showToast } from "../lib/toast";
import { truncateSessionTitle } from "../lib/sessionTitle";
import { mcpEnvConfigDraft, mcpRemoteConfigDraft, mcpTypeMessageKey, normalizeMcpDraft } from "../lib/mcpUi";
import { McpServerForm } from "../components/McpServerForm";
import styles from "./SettingsPage.module.css";

/** Settings fields that hold an API key (adapter-declared + shared LLM keys). */
type ApiKeyField = "cursorApiKey" | "anthropicApiKey" | "openaiApiKey";

/** Dumps rendered in one go; the wheel down the list asks for the next page. */
const DIAG_DUMPS_PAGE = 30;

/** Editable form state for one user-defined ACP agent (args/env as text). */
type CustomAgentDraft = {
  id: string;
  label: string;
  command: string;
  argsText: string;
  envText: string;
  binaryDirsText: string;
  restoreMode: AdapterRestoreMode;
  parameterizedModelPicker: boolean;
  subagentStreaming: boolean;
  cloudCatalog: boolean;
  /** True once the id was edited by hand — stop deriving it from the label. */
  idTouched: boolean;
};

/** Last Test result for a custom agent (spawn + initialize + session/new). */
type CustomAgentTest = {
  id: string;
  ok: boolean;
  message: string;
  models: number;
  modes: number;
};

/** Canonical display order for composer chips. */
const CHAT_CHIP_ORDER: ChatMetaChipId[] = [
  "folder",
  "board",
  "gitBranch",
  "gitChanges",
  "thoughts",
  "mcp",
  "context",
  "console",
];
import { isChatSearchEnabled, toggleChatTreeElement } from "../lib/chatTreeSearch";
const CHAT_TREE_MENU_ORDER: ChatTreeMenuId[] = ["rename", "move", "export", "delete"];
const CHAT_COMPOSER_ORDER: ChatComposerButtonId[] = ["attach", "mic", "model", "mode"];
const CHAT_HEADER_ICON_ORDER: ChatHeaderIconId[] = ["lang", "install", "theme"];

/** Toggle a value in a canonical-ordered array (re-adds in the right slot). */
function toggleInOrder<T>(current: T[], id: T, order: T[]): T[] {
  const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
  return order.filter((v) => next.includes(v));
}

/** One path per line, trimmed, blanks dropped. */
function parsePathLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Chat settings that affect the interactive preview (layout, chips, toolbar).
 * Shown inside the collapsible "Advanced" block on desktop and as the main
 * list on mobile (where the interactive preview is hidden).
 */
function ChatInteractiveConfigRows({
  form,
  patch,
  persistChatSplit,
}: {
  form: AppSettings;
  patch: (key: string, value: unknown) => void;
  persistChatSplit: (value: boolean) => void;
}) {
  const t = useT();
  const saveSettings = useAppStore((s) => s.saveSettings);
  const chipOptions = form.chatChipOptions ?? DEFAULT_CHAT_CHIP_OPTIONS;
  /**
   * The limit field is a free-text number input: keep the raw string while the
   * user types so a half-erased value ("1" of "12") is not force-corrected.
   */
  const [recentLimitDraft, setRecentLimitDraft] = useState(
    String(form.chatTreeRecentLimit ?? 0),
  );
  useEffect(() => {
    setRecentLimitDraft(String(form.chatTreeRecentLimit ?? 0));
  }, [form.chatTreeRecentLimit]);
  /** Per-chip rows save one field at a time; the patch is merged, not replaced. */
  const patchChipOptions = (patchOptions: Parameters<typeof mergeChatChipOptions>[1]) => {
    const next = mergeChatChipOptions(chipOptions, patchOptions);
    patch("chatChipOptions", next);
    void saveSettings({ chatChipOptions: next });
  };
  return (
    <SettingTable>
      <SettingRow label={t("settings.chatSplit")} hint={t("settings.chatSplitHint")}>
        <Toggle
          checked={form.chatSplit !== false}
          onChange={persistChatSplit}
          label={t("settings.chatSplit")}
        />
      </SettingRow>

      <SettingRow label={t("settings.chatToolbarStyle")} hint={t("settings.chatToolbarStyleHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["classic", t("settings.chatToolbarStyleClassic")],
              ["minimal", t("settings.chatToolbarStyleMinimal")],
            ] as const
          ).map(([id, label]) => {
            const on = (form.chatToolbarStyle ?? "classic") === id;
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() => patch("chatToolbarStyle", id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatActions")} hint={t("settings.chatActionsHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["copy", t("settings.chatActionCopy")],
              ["edit", t("settings.chatActionEdit")],
              ["like", t("settings.chatActionLike")],
              ["dislike", t("settings.chatActionDislike")],
              ["share", t("settings.chatActionShare")],
              ["regenerate", t("settings.chatActionRegenerate")],
              ["readAloud", t("settings.chatActionReadAloud")],
            ] as Array<[ChatActionId, string]>
          ).map(([id, label]) => {
            const on = (form.chatActions ?? []).includes(id);
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() =>
                  patch(
                    "chatActions",
                    on
                      ? (form.chatActions ?? []).filter((a) => a !== id)
                      : [...(form.chatActions ?? []), id],
                  )
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatMetaChips")} hint={t("settings.chatMetaChipsHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["folder", t("settings.chatMetaChipFolder")],
              ["board", t("settings.chatMetaChipBoard")],
              ["gitBranch", t("settings.chatMetaChipGitBranch")],
              ["gitChanges", t("settings.chatMetaChipGitChanges")],
              ["thoughts", t("settings.chatMetaChipThoughts")],
              ["mcp", t("settings.chatMetaChipMcp")],
              ["context", t("settings.chatMetaChipContext")],
              ["console", t("settings.chatMetaChipConsole")],
            ] as Array<[ChatMetaChipId, string]>
          ).map(([id, label]) => {
            const on = (form.chatMetaChips ?? []).includes(id);
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() =>
                  patch("chatMetaChips", toggleInOrder(form.chatMetaChips ?? [], id, CHAT_CHIP_ORDER))
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.thoughtsChipStyle")} hint={t("settings.thoughtsChipStyleHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["full", t("settings.thoughtsChipStyleFull")],
              ["icon", t("settings.thoughtsChipStyleIcon")],
            ] as const
          ).map(([id, label]) => {
            const on = (form.thoughtsChipStyle ?? "full") === id;
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() => patch("thoughtsChipStyle", id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatGitBranchPosition")} hint={t("settings.chatGitBranchPositionHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["below", t("settings.chatGitBranchPositionBelow")],
              ["above", t("settings.chatGitBranchPositionAbove")],
            ] as const
          ).map(([id, label]) => {
            const on = (form.chatGitBranchPosition ?? "below") === id;
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() => {
                  patch("chatGitBranchPosition", id);
                  void saveSettings({ chatGitBranchPosition: id });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatChipFolder")} hint={t("settings.chatChipFolderHint")}>
        <Toggle
          checked={chipOptions.folder.compress}
          onChange={(v) => patchChipOptions({ folder: { compress: v } })}
          label={t("settings.chatChipFolder")}
        />
      </SettingRow>

      <SettingRow
        label={t("settings.chatChipFolderTruncate")}
        hint={t("settings.chatChipFolderTruncateHint")}
      >
        <div className={styles.actionChips}>
          {(
            [
              ["middle", t("settings.chatChipFolderTruncateMiddle")],
              ["end", t("settings.chatChipFolderTruncateEnd")],
            ] as const
          ).map(([id, label]) => {
            const on = chipOptions.folder.truncate === id;
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() => patchChipOptions({ folder: { truncate: id } })}
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatChipBranch")} hint={t("settings.chatChipBranchHint")}>
        <Toggle
          checked={chipOptions.gitBranch.compress}
          onChange={(v) => patchChipOptions({ gitBranch: { compress: v } })}
          label={t("settings.chatChipBranch")}
        />
      </SettingRow>

      <SettingRow label={t("settings.chatChipChanges")} hint={t("settings.chatChipChangesHint")}>
        <Toggle
          checked={chipOptions.gitChanges.compress}
          onChange={(v) => patchChipOptions({ gitChanges: { compress: v } })}
          label={t("settings.chatChipChanges")}
        />
      </SettingRow>

      <SettingRow
        label={t("settings.chatChipChangesMetrics")}
        hint={t("settings.chatChipChangesMetricsHint")}
      >
        <div className={styles.actionChips}>
          {(
            [
              ["linesAndFiles", t("settings.chatChipChangesLinesAndFiles")],
              ["lines", t("settings.chatChipChangesLines")],
              ["files", t("settings.chatChipChangesFiles")],
              ["none", t("settings.chatChipChangesNone")],
            ] as const
          ).map(([id, label]) => {
            const on = chipOptions.gitChanges.metrics === id;
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() => patchChipOptions({ gitChanges: { metrics: id } })}
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatChipContext")} hint={t("settings.chatChipContextHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["usage", t("settings.chatChipContextUsage")],
              ["percent", t("settings.chatChipContextPercent")],
            ] as const
          ).map(([id, label]) => {
            const on = chipOptions.context.format === id;
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() => patchChipOptions({ context: { format: id } })}
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.consoleChipStyle")} hint={t("settings.consoleChipStyleHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["full", t("settings.consoleChipStyleFull")],
              ["icon", t("settings.consoleChipStyleIcon")],
            ] as const
          ).map(([id, label]) => {
            const on = (form.consoleChipStyle ?? "full") === id;
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() => patch("consoleChipStyle", id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatComposerButtons")} hint={t("settings.chatComposerButtonsHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["attach", t("settings.chatComposerBtnAttach")],
              ["mic", t("settings.chatComposerBtnMic")],
              ["model", t("settings.chatComposerBtnModel")],
              ["mode", t("settings.chatComposerBtnMode")],
            ] as Array<[ChatComposerButtonId, string]>
          ).map(([id, label]) => {
            const on = (form.chatComposerButtons ?? []).includes(id);
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() =>
                  patch(
                    "chatComposerButtons",
                    toggleInOrder(form.chatComposerButtons ?? [], id, CHAT_COMPOSER_ORDER),
                  )
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow
        label={t("settings.attachDefaultSource")}
        hint={t("settings.attachDefaultSourceHint")}
      >
        <div className={styles.actionChips}>
          {(
            [
              ["device", t("settings.attachSourceDevice")],
              ["server", t("settings.attachSourceServer")],
            ] as Array<[AttachSource, string]>
          ).map(([id, label]) => {
            const on = (form.attachDefaultSource ?? "device") === id;
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() => {
                  patch("attachDefaultSource", id);
                  void saveSettings({ attachDefaultSource: id });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatTreeElements")} hint={t("settings.chatTreeElementsHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["search", t("settings.chatTreeElSearch")],
              ["pin", t("settings.chatTreeElPin")],
              ["archive", t("settings.chatTreeElArchive")],
              ["more", t("settings.chatTreeElMore")],
            ] as Array<[ChatTreeElementId, string]>
          ).map(([id, label]) => {
            const on =
              id === "search"
                ? isChatSearchEnabled(form.chatTreeElements)
                : (form.chatTreeElements ?? []).includes(id);
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() =>
                  patch(
                    "chatTreeElements",
                    toggleChatTreeElement(form.chatTreeElements ?? [], id),
                  )
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow
        label={t("settings.chatTreeRecentLimit")}
        hint={t("settings.chatTreeRecentLimitHint")}
      >
        <input
          type="number"
          className={styles.numberInput}
          min={0}
          max={CHAT_TREE_RECENT_LIMIT_MAX}
          step={1}
          inputMode="numeric"
          value={recentLimitDraft}
          aria-label={t("settings.chatTreeRecentLimit")}
          onChange={(e) => {
            const raw = e.target.value;
            setRecentLimitDraft(raw);
            if (raw.trim() === "") return;
            const parsed = Number(raw);
            if (!Number.isFinite(parsed)) return;
            const next = normalizeChatTreeRecentLimit(parsed);
            patch("chatTreeRecentLimit", next);
            void saveSettings({ chatTreeRecentLimit: next });
          }}
          onBlur={() => setRecentLimitDraft(String(form.chatTreeRecentLimit ?? 0))}
        />
      </SettingRow>

      <SettingRow label={t("settings.chatTreeMenuTitle")} hint={t("settings.chatTreeMenuHint")}>
        <div className={styles.actionChips}>
          {(
            [
              ["rename", t("chat.renameSession")],
              ["move", t("chat.newInFolder")],
              ["export", t("chat.exportChat")],
              ["delete", t("common.delete")],
            ] as Array<[ChatTreeMenuId, string]>
          ).map(([id, label]) => {
            const on = (form.chatTreeMenu ?? []).includes(id);
            return (
              <button
                key={id}
                type="button"
                className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                aria-pressed={on}
                onClick={() =>
                  patch(
                    "chatTreeMenu",
                    toggleInOrder(form.chatTreeMenu ?? [], id, CHAT_TREE_MENU_ORDER),
                  )
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label={t("settings.chatShowMessageTime")} hint={t("settings.chatShowMessageTimeHint")}>
        <Toggle
          checked={Boolean(form.chatShowMessageTime)}
          onChange={(v) => patch("chatShowMessageTime", v)}
          label={t("settings.chatShowMessageTime")}
        />
      </SettingRow>
    </SettingTable>
  );
}

/** Chat behavior settings. Only the agent turn timeline changes the preview's
 *  mock (it decides which of the two readings is drawn); the rest are switches
 *  with nothing to show there. */
function ChatBehaviorConfigRows({
  form,
  patch,
}: {
  form: AppSettings;
  patch: (key: string, value: unknown) => void;
}) {
  const t = useT();
  return (
    <SettingTable>
      <SettingRow label={t("settings.chatEnterToSend")} hint={t("settings.chatEnterToSendHint")}>
        <Toggle
          checked={Boolean(form.chatEnterToSend)}
          onChange={(v) => patch("chatEnterToSend", v)}
          label={t("settings.chatEnterToSend")}
        />
      </SettingRow>

      <SettingRow label={t("settings.chatAgentTurnTimeline")} hint={t("settings.chatAgentTurnTimelineHint")}>
        <Toggle
          checked={Boolean(form.chatAgentTurnTimeline)}
          onChange={(v) => patch("chatAgentTurnTimeline", v)}
          label={t("settings.chatAgentTurnTimeline")}
        />
      </SettingRow>
    </SettingTable>
  );
}

function SchemeCard({
  active,
  name,
  colors,
  onClick,
}: {
  active: boolean;
  name: string;
  colors: string[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.schemeCard}${active ? ` ${styles.schemeCardActive}` : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className={styles.schemeDots} aria-hidden>
        {colors.map((c, i) => (
          <span key={i} className={styles.schemeDot} style={{ background: c }} />
        ))}
      </span>
      <span className={styles.schemeCardName}>{name}</span>
    </button>
  );
}

/**
 * Search results: section blocks with matching setting descriptions.
 * Each block shows the leaf name + a brief description from the search index.
 * Clicking a block opens the full settings page for that section.
 * Sections with no children (standalone pages) are excluded.
 */
function SearchResults({
  hits,
  query,
  adapters,
  onNavigate,
}: {
  hits: { section: string; leaf: string; label: string }[];
  query: string;
  adapters: AdapterMetaDto[];
  onNavigate: (section: SettingsSection, leaf: SettingsLeaf) => void;
}) {
  const t = useT();
  const tree = useMemo(() => getSettingsTree(t), [t]);
  const searchIdx = useMemo(() => settingsSearchIndex(t, adapters), [t, adapters]);
  const hl = (text: string) => highlightText(text, query);

  /** Get the first meaningful description term, skipping the leaf's own label. */
  const leafDesc = (leafId: string, leafLabel: string): string => {
    const terms = (searchIdx[leafId as SettingsLeaf] ?? []).filter(
      (t) => t.toLowerCase() !== leafLabel.toLowerCase(),
    );
    return terms[0] ?? "";
  };

  /** Group hits by section, drop sections with no children. */
  const sections = useMemo(() => {
    const map = new Map<string, { section: string; leaves: typeof hits }>();
    for (const h of hits) {
      const branch = tree.find((b) => b.id === h.section);
      if (!branch || branch.children.length === 0) continue;
      const existing = map.get(h.section);
      if (existing) existing.leaves.push(h);
      else map.set(h.section, { section: h.section, leaves: [h] });
    }
    return Array.from(map.values());
  }, [hits, tree]);

  if (sections.length === 0) {
    return (
      <>
        <header className={styles.header}>
          <div>
            <h1>{t("settings.searchResultsTitle")}</h1>
          </div>
        </header>
        <p className={styles.hint}>{t("settings.searchNoResults")}</p>
      </>
    );
  }

  return (
    <>
      <header className={styles.header}>
        <div>
          <h1>{t("settings.searchResultsTitle")}</h1>
          <p className={styles.lead}>
            {t("settings.searchResultsCount", { count: hits.length })}
          </p>
        </div>
      </header>
      <nav className={styles.searchSidebar}>
        {sections.map((sec) => {
          const branch = tree.find((b) => b.id === sec.section);
          return (
            <div key={sec.section} className={styles.searchSidebarSection}>
              <span className={styles.searchSidebarSectionTitle}>
                {branch ? hl(branch.label) : sec.section}
              </span>
              <div className={styles.searchSidebarItems}>
                {sec.leaves.map((leaf) => (
                  <button
                    key={leaf.leaf}
                    type="button"
                    className={styles.searchSidebarItem}
                    onClick={() => onNavigate(sec.section as SettingsSection, leaf.leaf as SettingsLeaf)}
                  >
                    <span className={styles.searchSidebarItemContent}>
                      <span className={styles.searchSidebarItemLabel}>{hl(leaf.label)}</span>
                      <span className={styles.searchSidebarItemDesc}>{leafDesc(leaf.leaf, leaf.label)}</span>
                    </span>
                    <span className={styles.searchSidebarItemArrow} aria-hidden>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
    </>
  );
}

export function SettingsPage() {
  const t = useT();
  const adapters = useAppStore((s) => s.adapters);
  const allAdapters = useAppStore((s) => s.allAdapters);
  /** API-key rows: enabled harnesses' own keys, then the shared LLM keys. */
  const apiKeyRows = useMemo(() => {
    const fromProviders = adapters.flatMap((a) => {
      const key = a.apiKeyField as ApiKeyField | undefined;
      if (!key) return [];
      return [
        {
          key,
          label: `${a.label} ${t("settings.apiKeys")}`,
          env: a.envApiKeyName ?? "",
          placeholder: "",
        },
      ];
    });
    return [
      ...fromProviders,
      {
        key: "anthropicApiKey" as const,
        label: `Anthropic ${t("settings.apiKeys")}`,
        env: "ANTHROPIC_API_KEY",
        placeholder: "sk-ant-...",
      },
      {
        key: "openaiApiKey" as const,
        label: `OpenAI ${t("settings.apiKeys")}`,
        env: "OPENAI_API_KEY",
        placeholder: "",
      },
    ];
  }, [adapters, t]);
  /**
   * Session-restore hint. Lists only the enabled harnesses and their real
   * restore mode, so a switched-off agent is not named here either.
   */
  const resumeHint = useMemo(() => {
    const base = t("settings.resumeAgentContextHint");
    const details = adapters.flatMap((a) =>
      a.restoreMode === "resume" || a.restoreMode === "load"
        ? [t("settings.resumeAgentContextVia", { agent: a.label, mode: `session/${a.restoreMode}` })]
        : [],
    );
    return details.length
      ? `${base} ${t("settings.resumeAgentContextRestore", { agents: details.join(", ") })}`
      : base;
  }, [adapters, t]);
  /**
   * Every registered harness with its on/off state — the Connect leaf is the
   * one place a switched-off agent stays visible (its toggle lives there).
   * Rows appear once /api/adapters answers; guessing before that could name a
   * harness the user switched off.
   */
  const providerRows = useMemo(
    () =>
      allAdapters.map((a) => ({
        id: a.id as AgentProvider,
        title: a.label,
        // A user-defined agent has no i18n key — show what it will launch.
        description:
          a.custom === true
            ? [a.defaultCommand, ...a.defaultArgs].join(" ")
            : t(a.descriptionKey as "settings.cursorDesc" | "settings.ompDesc"),
        enabled: a.enabled !== false,
      })),
    [allAdapters, t],
  );
  /** Enabled harnesses — model defaults, agent pickers and CLI forms. */
  const providers = useMemo(
    () => adapters.map((a) => ({ id: a.id as AgentProvider, title: a.label })),
    [adapters],
  );
  const location = useLocation();
  const navigate = useNavigate();
  const { section, leaf } = useMemo(
    () => parseSettingsSearch(location.search),
    [location.search],
  );
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const agentAvailability = useAppStore((s) => s.agentAvailability);
  const settingsQuery = useAppStore((s) => s.settingsQuery);
  const setSettingsQuery = useAppStore((s) => s.setSettingsQuery);
  /** Show SearchResults panel; false = show normal page with highlighted text. */
  const [viewingResults, setViewingResults] = useState(true);
  // When section/leaf change (navigation via click), show page view.
  const prevSectionRef = useRef(`${section}:${leaf}`);
  useEffect(() => {
    const key = `${section}:${leaf}`;
    if (key !== prevSectionRef.current) {
      prevSectionRef.current = key;
      setViewingResults(false);
    }
  }, [section, leaf]);
  // When query changes (typing), show results panel — but only if we didn't
  // just navigate (the section/leaf effect already handled that frame).
  const prevQueryRef = useRef(settingsQuery);
  useEffect(() => {
    if (settingsQuery !== prevQueryRef.current) {
      prevQueryRef.current = settingsQuery;
      if (settingsQuery.trim()) setViewingResults(true);
    }
  }, [settingsQuery]);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const serverPlatform = useAppStore((s) => s.serverPlatform);
  const showTerminalShell = serverPlatform === "win32";
  const searchIndex = useMemo(
    () => settingsSearchIndex(t, adapters),
    [t, adapters],
  );
  /** Leaves whose label or index terms match the active search. */
  const searchHits = useMemo(() => {
    const q = settingsQuery.trim();
    if (!q) return [];
    return getSettingsTree(t).flatMap((branch) =>
      branch.children
        .filter((item) => matchAny([item.label, ...(searchIndex[item.id] ?? [])], q))
        .map((item) => ({
          section: branch.id,
          leaf: item.id,
          label: item.label,
          branch: branch.label,
        })),
    );
  }, [settingsQuery, t, searchIndex]);
  const [form, setForm] = useState<AppSettings>(settings);
  const [folderBrowseOpen, setFolderBrowseOpen] = useState(false);
  const [folderBrowseTarget, setFolderBrowseTarget] = useState<
    "defaultCwd" | "diagnosticsDir" | "exportDir"
  >("defaultCwd");
  const [copied, setCopied] = useState(false);

  // Live-preview the appearance (font + palettes) while editing; the store
  // re-applies the saved settings after saveSettings.
  useEffect(() => {
    applyAppearance(form);
  }, [
    form.fontFamily,
    form.fontSize,
    form.lightScheme,
    form.darkScheme,
    form.lightAccent,
    form.lightBg,
    form.lightSurface,
    form.darkAccent,
    form.darkBg,
    form.darkSurface,
  ]);
  const [mcpDraft, setMcpDraft] = useState<McpServerConfig | null>(null);
  // Raw text of the one-path-per-line textareas while they hold focus. The
  // normalized form (blank lines dropped) would swallow the empty line Enter
  // just created and pin the caret, so typing continues against the draft and
  // the canonical join returns once the field loses focus.
  const [skillPathsDraft, setSkillPathsDraft] = useState<string | null>(null);
  const [mcpFilesDraft, setMcpFilesDraft] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<Record<string, boolean>>({});
  const [ttsHasNatural, setTtsHasNatural] = useState(false);
  const [ttsTestEngine, setTtsTestEngine] = useState<"idle" | "browser">("idle");
  const [modelsByProvider, setModelsByProvider] = useState<
    Partial<Record<AgentProvider, ModelOption[]>>
  >({});
  /** Per-model config-option schemas, keyed by `${provider}:${model}`. */
  const [paramsByModelKey, setParamsByModelKey] = useState<Record<string, ModelParamDto[]>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [paramsLoadingKey, setParamsLoadingKey] = useState<string | null>(null);
  const [diagDirDefault, setDiagDirDefault] = useState("");
  const [diagDirResolved, setDiagDirResolved] = useState("");
  const [exportDirDefault, setExportDirDefault] = useState("");
  const [diagItems, setDiagItems] = useState<DiagnosticsDumpMeta[]>([]);
  /** How many of `diagItems` are built; the rest wait for the scroll. */
  const [diagVisible, setDiagVisible] = useState(DIAG_DUMPS_PAGE);
  const diagScrollRef = useRef<HTMLUListElement | null>(null);
  const diagMoreRef = useRef<HTMLLIElement | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagMessage, setDiagMessage] = useState<string | null>(null);
  const [diagSessionId, setDiagSessionId] = useState<string | null>(
    () => useAppStore.getState().activeSessionId,
  );
  const [diagCopyId, setDiagCopyId] = useState<string | null>(null);
  const [chatsExportBusy, setChatsExportBusy] = useState(false);
  const [chatsExportMessage, setChatsExportMessage] = useState<string | null>(null);
  const paramsCacheRef = useRef(new Map<string, ModelParamDto[]>());
  /** Blocks catalog ingest from clobbering an in-flight default-model save. */
  const pendingModelPickRef = useRef<Partial<Record<AgentProvider, string>>>({});

  // The form picks the store payload up exactly once — when bootstrap resolves.
  // The store holds DEFAULT_SETTINGS until then and a deep link paints this page
  // before that, so the arrival is the one moment the payload is news. Never
  // re-sync afterwards: `saveSettings` re-sets `settings` twice around every
  // save (an optimistic chatSplit, then the PUT response) and the shell's
  // theme/locale toggles do too — echoing those snapshots reverted the edits in
  // progress, which is what dropped the MCP switches on the first save of a page
  // mounted after bootstrap (bug 2fb5d4c was the same class of revert).
  const bootstrapped = useAppStore((s) => s.bootstrapped);
  const formHydrated = useRef(bootstrapped);
  useEffect(() => {
    if (formHydrated.current || !bootstrapped) return;
    formHydrated.current = true;
    setForm(settings);
  }, [bootstrapped, settings]);

  useEffect(() => {
    if (leaf !== "diagnostics") return;
    setDiagSessionId((prev) => {
      if (prev === "") return prev;
      if (prev && sessions.some((s) => s.id === prev)) return prev;
      if (activeSessionId && sessions.some((s) => s.id === activeSessionId)) {
        return activeSessionId;
      }
      return sessions[0]?.id ?? "";
    });
  }, [leaf, sessions, activeSessionId]);

  const refreshDiagnostics = async () => {
    setDiagLoading(true);
    setDiagMessage(null);
    try {
      const [list, def] = await Promise.all([
        api.listDiagnostics(),
        api.getDiagnosticsDefaultDir(),
      ]);
      setDiagItems(list.items);
      setDiagDirResolved(list.dir);
      setDiagDirDefault(def.path || list.defaultDir);
    } catch (err) {
      setDiagMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagLoading(false);
    }
  };

  // The folder can hold hundreds of dumps and every card is a row of controls:
  // only the pages above the current scroll are built. The sentinel under the
  // last card asks for the next page as soon as it scrolls into the list, so a
  // list opened on a tall window fills itself instead of stopping at one page.
  const diagShown = diagItems.slice(0, diagVisible);
  const diagHasMore = diagShown.length < diagItems.length;

  useEffect(() => {
    if (!diagHasMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = diagMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setDiagVisible((n) => Math.min(n + DIAG_DUMPS_PAGE, diagItems.length));
      },
      { root: diagScrollRef.current, rootMargin: "200px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [diagHasMore, diagVisible, diagItems.length]);

  useEffect(() => {
    if (leaf !== "diagnostics") return;
    void refreshDiagnostics();
    let cancelled = false;
    api
      .getExportDefaultDir()
      .then((res) => {
        if (!cancelled) setExportDirDefault(res.path);
      })
      .catch(() => {
        // hint just stays hidden
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaf]);

  useEffect(() => {
    if (leaf !== "advanced") return;
    let cancelled = false;
    api
      .getExportDefaultDir()
      .then((res) => {
        if (!cancelled) setExportDirDefault(res.path);
      })
      .catch(() => {
        // leave default empty — hint shows nothing
      });
    return () => {
      cancelled = true;
    };
  }, [leaf]);

  useEffect(() => {
    if (section !== "interface" || leaf !== "voice") return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    const check = () => {
      setTtsHasNatural(synth.getVoices().some((v) => /natural|neural|premium/i.test(v.name)));
    };
    check();
    const onChanged = () => check();
    synth.addEventListener?.("voiceschanged", onChanged);
    synth.onvoiceschanged = onChanged;
    return () => {
      synth.removeEventListener?.("voiceschanged", onChanged);
      synth.onvoiceschanged = null;
    };
  }, [section, leaf]);

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };
  /** Adapter-declared settings fields (command/args/apiKey) — not in AppSettings. */
  const patchAny = (key: string, value: unknown) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };
  const persistChatSplit = (value: boolean) => {
    patch("chatSplit", value);
    if (!value) useAppStore.getState().collapseToSinglePane();
    void saveSettings({ chatSplit: value });
  };
  /**
   * Switch a harness on/off. The server heals default/connected provider on
   * read, but the form must move its default off the harness immediately so
   * the picker never points at a disabled one.
   */
  const setProviderEnabled = (id: AgentProvider, enabled: boolean) => {
    const disabled = form.disabledProviders ?? [];
    const nextDisabled = enabled
      ? disabled.filter((v) => v !== id)
      : [...new Set([...disabled, id])];
    const nextPatch: Partial<AppSettings> = { disabledProviders: nextDisabled };
    patch("disabledProviders", nextDisabled);
    if (!enabled && form.defaultProvider === id) {
      const fallback = providerRows.find((p) => p.enabled && p.id !== id);
      if (fallback) {
        const model = form.defaultModelByProvider?.[fallback.id] ?? "";
        const params = form.defaultModelParamsByProvider?.[fallback.id] ?? {};
        nextPatch.defaultProvider = fallback.id;
        nextPatch.defaultModel = model;
        nextPatch.defaultModelParams = params;
        patch("defaultProvider", fallback.id);
        patch("defaultModel", model);
        patch("defaultModelParams", params);
      }
    }
    void saveSettings(nextPatch);
  };

  const mcpServers = form.mcpServers ?? [];

  // Live probe status for enabled MCP servers. Polled while the MCP section
  // is open: the server probes endpoints asynchronously and settings only
  // reach it on save — a one-shot fetch right after a toggle/save would be
  // stale (that's why a reload used to be required).
  useEffect(() => {
    if (leaf !== "mcp") return;
    let alive = true;
    const fetchStatus = () =>
      api
        .mcpStatus()
        .then((s) => {
          if (alive) setMcpStatus(s);
        })
        .catch(() => {
          // server offline — keep previous dots
        });
    void fetchStatus();
    const timer = window.setInterval(fetchStatus, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [leaf]);

  const updateMcp = (id: string, change: Partial<McpServerConfig>) => {
    patch(
      "mcpServers",
      mcpServers.map((s) => (s.id === id ? { ...s, ...change } : s)),
    );
  };

  const removeMcp = (id: string) => {
    patch(
      "mcpServers",
      mcpServers.filter((s) => s.id !== id),
    );
  };

  const saveMcp = () => {
    if (!mcpDraft) return;
    const next = normalizeMcpDraft(mcpDraft);
    if (!next) return;
    patch(
      "mcpServers",
      mcpServers.some((s) => s.id === next.id)
        ? mcpServers.map((s) => (s.id === next.id ? next : s))
        : [...mcpServers, next],
    );
    setMcpDraft(null);
  };

  // ── Custom ACP agents (Settings → Connect) ────────────────────────────────
  const customAgents = form.customAgents ?? [];
  const [agentDraft, setAgentDraft] = useState<CustomAgentDraft | null>(null);
  const [agentError, setAgentError] = useState("");
  const [agentTest, setAgentTest] = useState<CustomAgentTest | null>(null);

  /** Ids a new agent must not take (its own id is excluded while editing). */
  const reservedAgentIds = useMemo(
    () => [...allAdapters.map((a) => a.id), SHELL_SESSION_PROVIDER],
    [allAdapters],
  );

  const draftFromSpec = (spec?: CustomAgentSpec): CustomAgentDraft => ({
    id: spec?.id ?? "",
    label: spec?.label ?? "",
    command: spec?.command ?? "",
    argsText: formatArgs(spec?.args ?? []),
    envText: formatEnvLines(spec?.env),
    binaryDirsText: (spec?.binaryDirs ?? []).join(" "),
    restoreMode: spec?.restoreMode ?? "resume",
    parameterizedModelPicker: spec?.parameterizedModelPicker ?? true,
    subagentStreaming: spec?.subagentStreaming ?? false,
    cloudCatalog: spec?.cloudCatalog ?? false,
    idTouched: Boolean(spec),
  });

  /** Spawn the agent once and report what it answered (models/modes/error). */
  const runAgentProbe = async (id: string) => {
    try {
      const res = await api.probeAgent(id);
      useAppStore.getState().setAgentAvailable(id, res.ok);
      setAgentTest({
        id,
        ok: res.ok,
        message: res.message,
        models: res.models?.length ?? 0,
        modes: res.modes?.length ?? 0,
      });
    } catch (err) {
      setAgentTest({
        id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        models: 0,
        modes: 0,
      });
    }
  };

  const saveAgent = () => {
    if (!agentDraft) return;
    const spec: CustomAgentSpec = {
      id: agentDraft.id.trim() || normalizeCustomAgentId(agentDraft.label),
      label: agentDraft.label.trim(),
      command: agentDraft.command.trim(),
      args: splitArgs(agentDraft.argsText),
      env: parseEnvLines(agentDraft.envText),
      binaryDirs: splitArgs(agentDraft.binaryDirsText),
      restoreMode: agentDraft.restoreMode,
      // session/load replays history the core already stores.
      suppressReplayOnLoad: agentDraft.restoreMode === "load",
      parameterizedModelPicker: agentDraft.parameterizedModelPicker,
      subagentStreaming: agentDraft.subagentStreaming,
      cloudCatalog: agentDraft.cloudCatalog,
    };
    const [clean] = normalizeCustomAgents(
      [spec],
      reservedAgentIds.filter((id) => id !== spec.id),
    );
    if (!clean) {
      setAgentError(t("settings.customAgentInvalid"));
      return;
    }
    const next = customAgents.some((a) => a.id === clean.id)
      ? customAgents.map((a) => (a.id === clean.id ? clean : a))
      : [...customAgents, clean];
    patch("customAgents", next);
    setAgentDraft(null);
    setAgentError("");
    setAgentTest(null);
    void saveSettings({ customAgents: next }).then(() => runAgentProbe(clean.id));
  };

  const removeAgent = (id: string) => {
    const next = customAgents.filter((a) => a.id !== id);
    patch("customAgents", next);
    setAgentDraft((draft) => (draft && draft.id === id ? null : draft));
    setAgentTest((prev) => (prev && prev.id === id ? null : prev));
    void saveSettings({ customAgents: next });
  };

  const loadParamsForModel = async (provider: AgentProvider, nextModel: string) => {
    const cacheKey = `${provider}:${nextModel}`;
    const commit = (list: ModelParamDto[]) =>
      setParamsByModelKey((prev) => (prev[cacheKey] === list ? prev : { ...prev, [cacheKey]: list }));
    const cached = paramsCacheRef.current.get(cacheKey);
    if (cached) {
      commit(cached);
      return;
    }
    setParamsLoadingKey(cacheKey);
    try {
      const res = await api.getModelParams(provider, nextModel);
      const fresh = res.modelParams ?? [];
      paramsCacheRef.current.set(cacheKey, fresh);
      commit(fresh);
    } finally {
      setParamsLoadingKey((key) => (key === cacheKey ? null : key));
    }
  };

  /** Persist a provider's default model + params (mirrors the chat composer's
   *  switch-and-apply semantics). */
  const saveDefaultModel = (
    provider: AgentProvider,
    value: string,
    params: Record<string, string>,
  ) => {
    pendingModelPickRef.current[provider] = value;
    let savePatch: Partial<AppSettings> | null = null;
    setForm((prev) => {
      const defaultModelByProvider = { ...prev.defaultModelByProvider, [provider]: value };
      const recentModelsByProvider = {
        ...prev.recentModelsByProvider,
        [provider]: pushRecentModel(prev.recentModelsByProvider?.[provider], value),
      };
      // Params picked from the ⋯ flyout belong to this model explicitly; a plain
      // model switch passes {} and must not touch either store.
      const hasParams = Object.keys(params).length > 0;
      const defaultModelParamsByProvider = hasParams
        ? { ...prev.defaultModelParamsByProvider, [provider]: params }
        : prev.defaultModelParamsByProvider;
      const modelParamsByProviderModel = hasParams
        ? {
            ...prev.modelParamsByProviderModel,
            [provider]: { ...prev.modelParamsByProviderModel?.[provider], [value]: params },
          }
        : prev.modelParamsByProviderModel;
      savePatch = {
        defaultModelByProvider,
        recentModelsByProvider,
        ...(hasParams ? { defaultModelParamsByProvider, modelParamsByProviderModel } : {}),
        ...(prev.defaultProvider === provider && hasParams
          ? { defaultModelParams: params }
          : prev.defaultProvider === provider
            ? { defaultModel: value }
            : {}),
      };
      return { ...prev, ...savePatch };
    });
    if (savePatch) {
      // Model picks apply live, exactly like the chat composer's picker —
      // they are defaults, not part of the Save-gated form.
      void saveSettings(savePatch).finally(() => {
        delete pendingModelPickRef.current[provider];
      });
    }
  };

  useEffect(() => {
    if (section !== "agent" || leaf !== "connect") return;
    void useAppStore.getState().probeAllAgents({ quiet: true });
  }, [section, leaf]);

  const onlineHarnessKey = providers
    .filter((p) => agentAvailability[p.id] === true)
    .map((p) => p.id)
    .join(",");

  useEffect(() => {
    if (section !== "agent" || leaf !== "model") return;
    const online = providers.filter((p) => agentAvailability[p.id] === true);
    for (const item of online) {
      const parameterized =
        adapters.find((a) => a.id === item.id)?.parameterizedModelPicker === true ||
        item.id === "cursor";
      if (!parameterized) continue;
      const pick = form.defaultModelByProvider?.[item.id];
      if (pick) void loadParamsForModel(item.id, pick);
    }
    // Prefetch Fast/Effort/Context so the picker can show a loader on first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, leaf, onlineHarnessKey, form.defaultModelByProvider]);

  useEffect(() => {
    if (section !== "agent" || leaf !== "model") return;
    const online = providers.filter((p) => agentAvailability[p.id] === true);
    if (!online.length) {
      setModelsLoading(false);
      setModelsError(null);
      return;
    }
    const seededModels: Partial<Record<AgentProvider, ModelOption[]>> = {};
    for (const item of online) {
      const cached = cachedModelsFor(item.id);
      if (cached?.models.length) {
        seededModels[item.id] = cached.models;
      }
    }
    if (Object.keys(seededModels).length) {
      setModelsByProvider((prev) => ({ ...seededModels, ...prev }));
    }
    const ingest = (
      id: AgentProvider,
      catalog: {
        models?: ModelOption[];
        modelParams?: ModelParamDto[];
        currentModel?: string;
      },
    ) => {
      setModelsByProvider((prev) => ({ ...prev, [id]: catalog.models ?? [] }));
      const currentPick =
        (catalog.currentModel &&
        (catalog.models ?? []).some((m) => m.value === catalog.currentModel)
          ? catalog.currentModel
          : "") ||
        "";
      const list = catalog.modelParams;
      if (list?.length && currentPick) {
        const key = `${id}:${currentPick}`;
        paramsCacheRef.current.set(key, list);
        setParamsByModelKey((prev) => (prev[key] === list ? prev : { ...prev, [key]: list }));
      }
      setForm((prev) => {
        if (pendingModelPickRef.current[id]) return prev;
        const models = catalog.models ?? [];
        const exposed = catalog.modelParams ?? [];
        const current = prev.defaultModelByProvider?.[id] || "";
        const currentValid = Boolean(current && models.some((m) => m.value === current));
        const catalogPick =
          catalog.currentModel && models.some((m) => m.value === catalog.currentModel)
            ? catalog.currentModel
            : models[0]?.value || "";
        let defaultModelByProvider = prev.defaultModelByProvider;
        if (!current) {
          defaultModelByProvider = { ...prev.defaultModelByProvider, [id]: catalogPick };
        } else if (!currentValid && catalogPick) {
          defaultModelByProvider = { ...prev.defaultModelByProvider, [id]: catalogPick };
        }
        const mapped = prev.defaultModelParamsByProvider?.[id] ?? {};
        const migrated = migrateModelParamValues(mapped, exposed);
        const nextProviderParams =
          Object.keys(migrated).length > 0
            ? migrated
            : Object.fromEntries(
                exposed
                  .filter((p) => p.currentValue != null && p.currentValue !== "")
                  .map((p) => [p.id, p.currentValue!]),
              );
        const seedingModel =
          !current || (!currentValid && Boolean(catalogPick));
        return {
          ...prev,
          defaultModelByProvider,
          defaultModelParamsByProvider: seedingModel
            ? {
                ...prev.defaultModelParamsByProvider,
                [id]: nextProviderParams,
              }
            : prev.defaultModelParamsByProvider,
        };
      });
    };
    for (const item of online) {
      const cached = cachedModelsFor(item.id);
      if (cached?.models.length) ingest(item.id, cached);
    }
    const missing = online.filter((item) => !seededModels[item.id]?.length);
    let cancelled = false;
    if (missing.length) setModelsLoading(true);
    else setModelsLoading(false);
    setModelsError(null);
    const fetchProviderModels = useAppStore.getState().fetchProviderModels;
    for (const item of online) {
      if (!seededModels[item.id]?.length) continue;
      void fetchProviderModels(item.id).then((catalog) => {
        if (cancelled || !catalog) return;
        ingest(item.id, catalog);
      });
    }
    void Promise.all(
      missing.map(async (item) => {
        const catalog = await fetchProviderModels(item.id);
        return { id: item.id, catalog };
      }),
    )
      .then((rows) => {
        if (cancelled) return;
        for (const { id, catalog } of rows) {
          if (catalog) ingest(id, catalog);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setModelsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section, leaf, onlineHarnessKey]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Never send defaultProvider, theme, or locale from the form submit — the
    // agent is bound via "Connect", and theme/locale are toggled from the
    // shell, so stale form values must not flip the interface on save.
    const { defaultProvider: _provider, theme: _theme, locale: _locale, ...rest } = form;
    await saveSettings(rest);
    // The MCP probes fire server-side on save — fetch once so the dots turn
    // green right away instead of waiting for the next poll tick.
    api
      .mcpStatus()
      .then((s) => setMcpStatus(s))
      .catch(() => {
        // poll will retry
      });
    showToast(t("settings.saved"), { tone: "success", id: "settings-saved" });
  };

  const clearApiKey = async (
    key: "cursorApiKey" | "anthropicApiKey" | "openaiApiKey",
  ) => {
    const next = { ...form, [key]: "" };
    setForm(next);
    const { defaultProvider: _provider, theme: _theme, locale: _locale, ...rest } = next;
    await saveSettings(rest);
    showToast(t("settings.saved"), { tone: "success", id: "settings-saved" });
  };

  const title =
    section === "interface"
      ? leaf === "colors"
        ? t("settings.colors")
        : leaf === "voice"
          ? t("settings.voiceTitle")
          : leaf === "chat"
            ? t("settings.chatTitle")
            : leaf === "board"
              ? t("settings.boardTitle")
              : t("settings.appearance")
      : section === "agent"
        ? leaf === "connect"
          ? t("settings.agentConnectTitle")
          : leaf === "model"
            ? t("settings.agentModelTitle")
            : leaf === "builtin"
              ? t("settings.builtinTitle")
              : leaf === "remote"
              ? t("settings.remoteAccessTitle")
              : leaf === "diagnostics"
                ? t("settings.diagnosticsTitle")
                : leaf === "mcp"
                  ? t("settings.mcpTitle")
                  : t("settings.agentAdvancedTitle")
        : t("settings.agentConnectTitle");

  const subtitle =
    section === "interface"
      ? leaf === "colors"
        ? t("settings.colorsDesc")
        : leaf === "voice"
          ? t("settings.voiceDesc")
          : leaf === "chat"
            ? t("settings.chatDesc")
            : leaf === "board"
              ? t("settings.boardDesc")
              : t("settings.sidebarCollapseHint")
      : section === "agent" && leaf === "mcp"
        ? t("settings.mcpHint")
    : section === "agent" && leaf === "advanced"
      ? t("settings.agentAdvancedDesc")
      : section === "agent" && leaf === "builtin"
        ? t("settings.builtinHint")
        : section === "agent" && leaf === "remote"
          ? t("settings.remoteAccessDesc")
          : section === "agent" && leaf === "diagnostics"
            ? t("settings.diagnosticsDesc")
            : t("settings.agentConnectDesc");

  const eyebrow = section === "interface" ? t("settings.interface") : t("settings.agents");
  const pageUrl = typeof window !== "undefined" ? window.location.origin : "";

  const copyUrl = async () => {
    if (!pageUrl) return;
    try {
      await navigator.clipboard.writeText(pageUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.mobileSearch}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={settingsQuery}
          onChange={(e) => setSettingsQuery(e.target.value)}
          placeholder={t("settings.searchPlaceholder")}
          aria-label={t("settings.searchPlaceholder")}
        />
        {settingsQuery ? (
          <button
            type="button"
            className={styles.mobileSearchClear}
            aria-label={t("settings.searchClear")}
            onClick={() => setSettingsQuery("")}
          >
            ×
          </button>
        ) : null}
      </div>
      <form
        className={`${styles.panel}${section === "interface" && leaf === "chat" ? ` ${styles.panelChat}` : ""}`}
        onSubmit={(e) => void onSubmit(e)}
      >
        <SettingsSearchProvider query={settingsQuery} filtering={viewingResults}>
        {settingsQuery.trim() && !viewingResults && (
          <div className={styles.searchBackBar}>
            <button type="button" className={styles.searchBackBtn} onClick={() => setViewingResults(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t("settings.searchBackToResults")}
            </button>
            <span className={styles.searchBackQueryTag}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span className={styles.searchBackQueryText}>{settingsQuery}</span>
            </span>
          </div>
        )}
        {(!settingsQuery.trim() || !viewingResults) && (
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>{highlightText(eyebrow, settingsQuery)}</p>
            <h1>{highlightText(title, settingsQuery)}</h1>
            <p className={styles.lead}>{highlightText(subtitle, settingsQuery)}</p>
          </div>
        </header>
        )}

        {settingsQuery.trim() && viewingResults ? (
          <SearchResults hits={searchHits} query={settingsQuery} adapters={adapters} onNavigate={(s, l) => { setViewingResults(false); navigate(settingsPath(s as SettingsSection, l as SettingsLeaf)); }} />
        ) : (<div style={{ display: "contents" }}>
        {section === "agent" && leaf === "connect" && (
          <>
            <p className={styles.hint}>{t("settings.agentEnabledHint")}</p>
            <SettingTable>
              {providerRows.map((item) => {
                const known = agentAvailability[item.id];
                const checking = item.enabled && known !== true && known !== false;
                const online = known === true;
                return (
                  <SettingRow
                    key={item.id}
                    terms={[
                      item.title,
                      item.description,
                      t("settings.enabled"),
                      t("settings.disabled"),
                    ]}
                    label={item.title}
                    hint={highlightText(item.description, settingsQuery)}
                  >
                    <span className={styles.providerRowControl}>
                      <span className={styles.providerProbeInline}>
                        {!item.enabled
                          ? t("settings.disabled")
                          : checking
                            ? t("common.checking")
                            : online
                              ? t("common.online")
                              : t("common.offline")}
                      </span>
                      <Toggle
                        checked={item.enabled}
                        onChange={(next) => setProviderEnabled(item.id, next)}
                        label={t("settings.enabled")}
                      />
                    </span>
                  </SettingRow>
                );
              })}
            </SettingTable>
            <SettingTable>
              <SettingRow
                label={t("settings.defaultAgent")}
                hint={t("settings.defaultAgentHint")}
                terms={[t("settings.defaultAgent"), t("settings.defaultAgentHint")]}
              >
                <OptionPicker
                  variant="block"
                  placement="down"
                  menuTitle={t("settings.defaultAgent")}
                  value={form.defaultProvider}
                  onChange={(v) => {
                    const id = v as AgentProvider;
                    patch("defaultProvider", id);
                    void saveSettings({
                      defaultProvider: id,
                      defaultModel: form.defaultModelByProvider?.[id] ?? "",
                      defaultModelParams: form.defaultModelParamsByProvider?.[id] ?? {},
                    });
                  }}
                  options={providers.map((item) => ({
                    value: item.id,
                    label: item.title,
                  }))}
                />
              </SettingRow>
            </SettingTable>

            <p className={styles.hint}>{t("settings.customAgentsHint")}</p>
            <SettingTable>
              {customAgents.map((agent) => (
                <SettingRow
                  key={agent.id}
                  terms={[
                    t("settings.customAgents"),
                    agent.label,
                    agent.id,
                    agent.command,
                    ...agent.args,
                  ]}
                  label={agent.label}
                  hint={[agent.command, ...agent.args].join(" ")}
                >
                  <span className={styles.providerRowControl}>
                    <span className={styles.providerProbeInline}>
                      {agentTest && agentTest.id === agent.id
                        ? agentTest.ok
                          ? t("common.online")
                          : t("common.offline")
                        : t("settings.customAgentUntested")}
                    </span>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => void runAgentProbe(agent.id)}
                    >
                      {t("settings.customAgentTest")}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => {
                        setAgentError("");
                        setAgentTest(null);
                        setAgentDraft(draftFromSpec(agent));
                      }}
                    >
                      {t("common.edit")}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => removeAgent(agent.id)}
                    >
                      {t("common.delete")}
                    </button>
                  </span>
                </SettingRow>
              ))}
              {customAgents.length === 0 ? (
                <SettingRow
                  label={t("settings.customAgentsEmpty")}
                  hint={t("settings.customAgentsEmptyHint")}
                />
              ) : null}
            </SettingTable>

            {agentTest ? (
              <p
                role="status"
                className={`${styles.customAgentTestResult}${
                  agentTest.ok ? "" : ` ${styles.customAgentTestResultError}`
                }`}
              >
                {agentTest.ok
                  ? t("settings.customAgentTestOk", {
                      models: String(agentTest.models),
                      modes: String(agentTest.modes),
                      message: agentTest.message,
                    })
                  : t("settings.customAgentTestFail", { error: agentTest.message })}
              </p>
            ) : null}

            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => {
                setAgentError("");
                setAgentTest(null);
                setAgentDraft(draftFromSpec());
              }}
            >
              + {t("settings.customAgentAdd")}
            </button>

            {agentDraft && (
              <div className={styles.mcpForm}>
                <input
                  className={styles.mcpInput}
                  placeholder={t("settings.customAgentLabel")}
                  value={agentDraft.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    setAgentDraft((draft) =>
                      draft
                        ? {
                            ...draft,
                            label,
                            id: draft.idTouched ? draft.id : normalizeCustomAgentId(label),
                          }
                        : draft,
                    );
                  }}
                />
                <input
                  className={styles.mcpInput}
                  placeholder={t("settings.customAgentId")}
                  value={agentDraft.id}
                  onChange={(e) =>
                    setAgentDraft((draft) =>
                      draft ? { ...draft, id: e.target.value, idTouched: true } : draft,
                    )
                  }
                />
                <input
                  className={styles.mcpInput}
                  placeholder={t("settings.customAgentCommand")}
                  value={agentDraft.command}
                  onChange={(e) =>
                    setAgentDraft((draft) => (draft ? { ...draft, command: e.target.value } : draft))
                  }
                />
                <input
                  className={styles.mcpInput}
                  placeholder={t("settings.customAgentArgs")}
                  value={agentDraft.argsText}
                  onChange={(e) =>
                    setAgentDraft((draft) => (draft ? { ...draft, argsText: e.target.value } : draft))
                  }
                />
                <input
                  className={styles.mcpInput}
                  placeholder={t("settings.customAgentBinaryDirs")}
                  value={agentDraft.binaryDirsText}
                  onChange={(e) =>
                    setAgentDraft((draft) =>
                      draft ? { ...draft, binaryDirsText: e.target.value } : draft,
                    )
                  }
                />
                <label className={styles.mcpJsonBlock}>
                  <span className={styles.mcpHeadersLabel}>{t("settings.customAgentEnv")}</span>
                  <textarea
                    className={styles.mcpJsonInput}
                    rows={4}
                    spellCheck={false}
                    placeholder={"KEY=VALUE"}
                    value={agentDraft.envText}
                    onChange={(e) =>
                      setAgentDraft((draft) => (draft ? { ...draft, envText: e.target.value } : draft))
                    }
                  />
                </label>
                <OptionPicker
                  variant="block"
                  placement="down"
                  menuTitle={t("settings.customAgentRestoreMode")}
                  value={agentDraft.restoreMode}
                  onChange={(v) =>
                    setAgentDraft((draft) =>
                      draft ? { ...draft, restoreMode: v as AdapterRestoreMode } : draft,
                    )
                  }
                  options={[
                    { value: "resume", label: "session/resume" },
                    { value: "load", label: "session/load" },
                    { value: "new", label: t("settings.customAgentRestoreNew") },
                  ]}
                />
                <label className={styles.mcpTlsRow}>
                  <input
                    type="checkbox"
                    checked={agentDraft.parameterizedModelPicker}
                    onChange={(e) =>
                      setAgentDraft((draft) =>
                        draft ? { ...draft, parameterizedModelPicker: e.target.checked } : draft,
                      )
                    }
                  />
                  <span>{t("settings.customAgentParams")}</span>
                  <span className={styles.mcpTlsHint}>{t("settings.customAgentParamsHint")}</span>
                </label>
                {agentError ? <p className={styles.fieldHint}>{agentError}</p> : null}
                <div className={styles.mcpFormActions}>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setAgentDraft(null);
                      setAgentError("");
                    }}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    disabled={!agentDraft.command.trim()}
                    onClick={saveAgent}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {section === "interface" && leaf === "appearance" && (
          <SettingTable>
            <SettingRow label={t("settings.sidebarCollapse")} hint={t("settings.sidebarCollapseHint")}>
              <OptionPicker
                variant="block"
                placement="down"
                menuTitle={t("settings.sidebarCollapse")}
                value={form.sidebarCollapse}
                onChange={(v) => patch("sidebarCollapse", v as AppSettings["sidebarCollapse"])}
                options={[
                  { value: "full", label: t("settings.sidebarCollapseFull") },
                  { value: "rail", label: t("settings.sidebarCollapseRail") },
                ]}
              />
            </SettingRow>

            <SettingRow label={t("settings.fontFamily")} hint={t("settings.fontFamilyHint")}>
              <OptionPicker
                variant="block"
                placement="down"
                menuTitle={t("settings.fontFamily")}
                value={form.fontFamily ?? ""}
                onChange={(v) => patch("fontFamily", v)}
                options={[
                  { value: "", label: t("common.default") },
                  { value: "figtree", label: "Figtree" },
                  { value: "inter", label: "Inter" },
                  { value: "system", label: t("settings.fontSystem") },
                ]}
              />
            </SettingRow>

            <SettingRow label={t("settings.fontSize")} hint={t("settings.fontSizeHint")}>
              <OptionPicker
                variant="block"
                placement="down"
                menuTitle={t("settings.fontSize")}
                value={form.fontSize ?? ""}
                onChange={(v) => patch("fontSize", v)}
                options={[
                  { value: "", label: t("common.default") },
                  { value: "sm", label: t("settings.fontSizeSmall") },
                  { value: "lg", label: t("settings.fontSizeLarge") },
                ]}
              />
            </SettingRow>

            <SettingRow label={t("settings.showBootSplash")} hint={t("settings.showBootSplashHint")}>
              <Toggle
                checked={Boolean(form.showBootSplash)}
                onChange={(v) => patch("showBootSplash", v)}
                label={t("settings.showBootSplash")}
              />
            </SettingRow>
          </SettingTable>
        )}

        {section === "interface" && leaf === "board" && (
          <SettingTable>
            <SettingRow label={t("settings.boardAddCardStyle")} hint={t("settings.boardAddCardStyleHint")}>
              <OptionPicker
                variant="block"
                placement="down"
                menuTitle={t("settings.boardAddCardStyle")}
                value={form.boardAddCardStyle ?? "card"}
                onChange={(v) => patch("boardAddCardStyle", v as AppSettings["boardAddCardStyle"])}
                options={[
                  { value: "card", label: t("settings.boardAddCardStyleCard") },
                  { value: "compact", label: t("settings.boardAddCardStyleCompact") },
                  { value: "hidden", label: t("settings.boardAddCardStyleHidden") },
                ]}
              />
            </SettingRow>
          </SettingTable>
        )}

        {section === "interface" && leaf === "colors" && (
          <SettingTable>
            <SettingRow label={t("settings.lightScheme")} hint={t("settings.lightSchemeHint")}>
              <div className={styles.schemeGridInline}>
                <SchemeCard
                  active={!form.lightScheme}
                  name={t("common.default")}
                  colors={[
                    SYSTEM_SWATCH.light.accent,
                    SYSTEM_SWATCH.light.bg,
                    SYSTEM_SWATCH.light.surface,
                  ]}
                  onClick={() => patch("lightScheme", "")}
                />
                {LIGHT_SCHEMES.map((s) => (
                  <SchemeCard
                    key={s.id}
                    active={form.lightScheme === s.id}
                    name={s.name}
                    colors={[s.vars["--accent"], s.vars["--bg"], s.vars["--surface"]]}
                    onClick={() => patch("lightScheme", s.id)}
                  />
                ))}
                <div
                  className={`${styles.schemeCard} ${styles.schemeCardCustom}${
                    form.lightScheme === "custom" ? ` ${styles.schemeCardActive}` : ""
                  }`}
                  onClick={() => patch("lightScheme", "custom")}
                >
                  <span className={styles.schemeDots} aria-hidden>
                    <span
                      className={styles.schemeDot}
                      style={{ background: form.lightAccent || SYSTEM_SWATCH.light.accent }}
                    />
                    <span
                      className={styles.schemeDot}
                      style={{ background: form.lightBg || SYSTEM_SWATCH.light.bg }}
                    />
                    <span
                      className={styles.schemeDot}
                      style={{ background: form.lightSurface || SYSTEM_SWATCH.light.surface }}
                    />
                  </span>
                  <span className={styles.schemeCardName}>{t("settings.customScheme")}</span>
                  <div
                    className={styles.customPickers}
                    onClick={(e) => e.stopPropagation()}
                    role="group"
                    aria-label={t("settings.customScheme")}
                  >
                    <label title={t("settings.customAccent")}>
                      <input
                        type="color"
                        value={form.lightAccent || SYSTEM_SWATCH.light.accent}
                        onChange={(e) => {
                          patch("lightAccent", e.target.value);
                          patch("lightScheme", "custom");
                        }}
                      />
                    </label>
                    <label title={t("settings.customBg")}>
                      <input
                        type="color"
                        value={form.lightBg || SYSTEM_SWATCH.light.bg}
                        onChange={(e) => {
                          patch("lightBg", e.target.value);
                          patch("lightScheme", "custom");
                        }}
                      />
                    </label>
                    <label title={t("settings.customSurface")}>
                      <input
                        type="color"
                        value={form.lightSurface || SYSTEM_SWATCH.light.surface}
                        onChange={(e) => {
                          patch("lightSurface", e.target.value);
                          patch("lightScheme", "custom");
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </SettingRow>

            <SettingRow label={t("settings.darkScheme")} hint={t("settings.darkSchemeHint")}>
              <div className={styles.schemeGridInline}>
                <SchemeCard
                  active={!form.darkScheme}
                  name={t("common.default")}
                  colors={[
                    SYSTEM_SWATCH.dark.accent,
                    SYSTEM_SWATCH.dark.bg,
                    SYSTEM_SWATCH.dark.surface,
                  ]}
                  onClick={() => patch("darkScheme", "")}
                />
                {DARK_SCHEMES.map((s) => (
                  <SchemeCard
                    key={s.id}
                    active={form.darkScheme === s.id}
                    name={s.name}
                    colors={[s.vars["--accent"], s.vars["--bg"], s.vars["--surface"]]}
                    onClick={() => patch("darkScheme", s.id)}
                  />
                ))}
                <div
                  className={`${styles.schemeCard} ${styles.schemeCardCustom}${
                    form.darkScheme === "custom" ? ` ${styles.schemeCardActive}` : ""
                  }`}
                  onClick={() => patch("darkScheme", "custom")}
                >
                  <span className={styles.schemeDots} aria-hidden>
                    <span
                      className={styles.schemeDot}
                      style={{ background: form.darkAccent || SYSTEM_SWATCH.dark.accent }}
                    />
                    <span
                      className={styles.schemeDot}
                      style={{ background: form.darkBg || SYSTEM_SWATCH.dark.bg }}
                    />
                    <span
                      className={styles.schemeDot}
                      style={{ background: form.darkSurface || SYSTEM_SWATCH.dark.surface }}
                    />
                  </span>
                  <span className={styles.schemeCardName}>{t("settings.customScheme")}</span>
                  <div
                    className={styles.customPickers}
                    onClick={(e) => e.stopPropagation()}
                    role="group"
                    aria-label={t("settings.customScheme")}
                  >
                    <label title={t("settings.customAccent")}>
                      <input
                        type="color"
                        value={form.darkAccent || SYSTEM_SWATCH.dark.accent}
                        onChange={(e) => {
                          patch("darkAccent", e.target.value);
                          patch("darkScheme", "custom");
                        }}
                      />
                    </label>
                    <label title={t("settings.customBg")}>
                      <input
                        type="color"
                        value={form.darkBg || SYSTEM_SWATCH.dark.bg}
                        onChange={(e) => {
                          patch("darkBg", e.target.value);
                          patch("darkScheme", "custom");
                        }}
                      />
                    </label>
                    <label title={t("settings.customSurface")}>
                      <input
                        type="color"
                        value={form.darkSurface || SYSTEM_SWATCH.dark.surface}
                        onChange={(e) => {
                          patch("darkSurface", e.target.value);
                          patch("darkScheme", "custom");
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </SettingRow>
          </SettingTable>
        )}

        {section === "interface" && leaf === "voice" && (
          <>
            <SettingTable>
              <SettingRow label={t("settings.ttsVoiceGender")} hint={t("settings.ttsVoiceGenderHint")}>
                <OptionPicker
                  variant="block"
                  placement="down"
                  menuTitle={t("settings.ttsVoiceGender")}
                  value={form.ttsVoiceGender ?? ""}
                  onChange={(v) => patch("ttsVoiceGender", v as AppSettings["ttsVoiceGender"])}
                  options={[
                    { value: "", label: t("common.default") },
                    { value: "female", label: t("settings.ttsGenderFemale") },
                    { value: "male", label: t("settings.ttsGenderMale") },
                  ]}
                />
              </SettingRow>
              <SettingRow label={t("settings.ttsTest")}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => {
                    stopReadAloud();
                    setTtsTestEngine("idle");
                    // Test in the user's own language only (single voice,
                    // no mixing) — phrase comes from i18n.
                    const testText = t("settings.ttsTestText");
                    startReadAloud(
                      testText,
                      settings.locale === "en" ? "en" : "ru",
                      form.ttsVoiceGender ?? "",
                      {
                        onStart: () => setTtsTestEngine("browser"),
                        onEnd: () => setTtsTestEngine("idle"),
                      },
                    );
                  }}
                >
                  {t("settings.ttsTest")}
                </button>
                {ttsTestEngine !== "idle" && (
                  <span className={styles.ttsTestStatus}>{t("settings.ttsTestBrowser")}</span>
                )}
              </SettingRow>
            </SettingTable>

            {!ttsHasNatural && (
              <SearchGate terms={[t("settings.ttsNaturalHint"), t("settings.ttsOpenWindowsSpeech")]}>
              <div className={styles.ttsNaturalWarn}>
                <p className={styles.fieldHint}>{t("settings.ttsNaturalHint")}</p>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => window.open("ms-settings:speech", "_self")}
                >
                  {t("settings.ttsOpenWindowsSpeech")}
                </button>
              </div>
              </SearchGate>
            )}
          </>
        )}

        {section === "interface" && leaf === "chat" && (
          <>
            <SearchGate>
              <p className={styles.chatSettingsIntro}>{t("settings.chatIntro")}</p>
              <div className={styles.previewDesktop}>
            <ChatSettingsPreview
              actions={form.chatActions ?? []}
              chips={form.chatMetaChips ?? []}
              composerButtons={form.chatComposerButtons ?? []}
              treeElements={form.chatTreeElements ?? []}
              treeMenu={form.chatTreeMenu ?? []}
              showArchive={Boolean(form.chatTreeShowArchive)}
              showTime={Boolean(form.chatShowMessageTime)}
              headerHeight={form.chatHeaderHeight ?? 52}
              headerIcons={form.chatHeaderIcons ?? []}
              chatSplit={form.chatSplit !== false}
              chatToolbarStyle={form.chatToolbarStyle ?? "classic"}
              chatGitBranchPosition={form.chatGitBranchPosition ?? "below"}
              agentTurnTimeline={Boolean(form.chatAgentTurnTimeline)}
              onToggleAction={(id) => {
                const cur = form.chatActions ?? [];
                patch(
                  "chatActions",
                  cur.includes(id) ? cur.filter((a) => a !== id) : [...cur, id],
                );
              }}
              onToggleChip={(id) => {
                const cur = form.chatMetaChips ?? [];
                patch(
                  "chatMetaChips",
                  cur.includes(id) ? cur.filter((chip) => chip !== id) : [...cur, id],
                );
              }}
              onReorderChip={(nextOrder) => patch("chatMetaChips", nextOrder)}
              onToggleComposerButton={(id) =>
                patch(
                  "chatComposerButtons",
                  toggleInOrder(form.chatComposerButtons ?? [], id, CHAT_COMPOSER_ORDER),
                )
              }
              onToggleTreeElement={(id) =>
                patch(
                  "chatTreeElements",
                  toggleChatTreeElement(form.chatTreeElements ?? [], id),
                )
              }
              onToggleShowArchive={() => patch("chatTreeShowArchive", !form.chatTreeShowArchive)}
              onToggleTreeMenu={(id) =>
                patch(
                  "chatTreeMenu",
                  toggleInOrder(form.chatTreeMenu ?? [], id, CHAT_TREE_MENU_ORDER),
                )
              }
              onHeaderHeight={(next) => patch("chatHeaderHeight", next)}
              onToggleHeaderIcon={(id) =>
                patch(
                  "chatHeaderIcons",
                  toggleInOrder(form.chatHeaderIcons ?? [], id, CHAT_HEADER_ICON_ORDER),
                )
              }
              onToggleChatSplit={() => persistChatSplit(form.chatSplit === false)}
              onReorderAction={(nextOrder) => {
                const enabled = new Set(form.chatActions ?? []);
                patch(
                  "chatActions",
                  nextOrder.filter((id) => enabled.has(id)),
                );
              }}
              onGitBranchPositionChange={(pos) => {
                patch("chatGitBranchPosition", pos);
                void saveSettings({ chatGitBranchPosition: pos });
              }}
            />
              </div>
            </SearchGate>
            {settingsQuery.trim() ? (
              <div className={styles.chatSearchRows}>
                <h2 className={styles.sectionHeading}>{highlightText(t("settings.chatAdvanced"), settingsQuery)}</h2>
                <ChatInteractiveConfigRows form={form} patch={patchAny} persistChatSplit={persistChatSplit} />
                <h2 className={styles.sectionHeading}>{highlightText(t("settings.chatBehavior"), settingsQuery)}</h2>
                <ChatBehaviorConfigRows form={form} patch={patchAny} />
              </div>
            ) : (
              <>
                <div className={styles.mobileConfig}>
                  <ChatInteractiveConfigRows form={form} patch={patchAny} persistChatSplit={persistChatSplit} />
                </div>
                <details className={styles.chatAdvancedDetails}>
                  <summary>{t("settings.chatAdvanced")}</summary>
                  <ChatInteractiveConfigRows form={form} patch={patchAny} persistChatSplit={persistChatSplit} />
                </details>
                <div className={styles.chatBehaviorBlock}>
                  <h2 className={styles.sectionHeading}>{t("settings.chatBehavior")}</h2>
                  <ChatBehaviorConfigRows form={form} patch={patchAny} />
                </div>
              </>
            )}
          </>
        )}

        {section === "agent" && leaf === "model" && (
          providers.filter((p) => agentAvailability[p.id] === true).length === 0 ? (
            <p className={styles.hint}>{t("common.noAgentsOnline")}</p>
          ) : (
            <SettingTable>
              {providers
                .filter((p) => agentAvailability[p.id] === true)
                .map((item) => {
                  const models = modelsByProvider[item.id] ?? [];
                  const model = form.defaultModelByProvider?.[item.id] ?? "";
                  const modelParams = paramsByModelKey[`${item.id}:${model}`] ?? [];
                  const paramValues = form.defaultModelParamsByProvider?.[item.id] ?? {};
                  const parameterized =
                    adapters.find((a) => a.id === item.id)?.parameterizedModelPicker === true ||
                    item.id === "cursor";
                  const loadingFor = paramsLoadingKey?.startsWith(`${item.id}:`)
                    ? paramsLoadingKey.slice(item.id.length + 1)
                    : undefined;
                  const loadingParams =
                    Boolean(loadingFor) ||
                    (parameterized && modelsLoading && modelParams.length === 0);
                  const scopedParams: Record<string, ModelParamDto[]> = {};
                  for (const [key, list] of Object.entries(paramsByModelKey)) {
                    if (key.startsWith(`${item.id}:`)) {
                      scopedParams[key.slice(item.id.length + 1)] = list;
                    }
                  }
                  return (
                    <SettingRow
                      key={item.id}
                      layout="stack"
                      label={t("settings.defaultModelFor", { agent: item.title })}
                      terms={[model]}
                    >
                      <ModelPicker
                        model={model}
                        models={models}
                        params={modelParams}
                        paramValues={paramValues}
                        paramsByModel={scopedParams}
                        paramsLoading={loadingParams}
                        paramsLoadingFor={loadingFor}
                        showParamsMenu={parameterized || modelParams.length > 0}
                        onChange={(value) => {
                          saveDefaultModel(item.id, value, {});
                          void loadParamsForModel(item.id, value);
                        }}
                        onParamsChange={(target, next) => {
                          // The ⋯ flyout belongs to `target`: migrate against the
                          // target's own schema and make it the provider default.
                          const schema =
                            target === model ? modelParams : (scopedParams[target] ?? []);
                          const migrated =
                            schema.length === 0 ? next : migrateModelParamValues(next, schema);
                          saveDefaultModel(item.id, target, migrated);
                          if (target !== model) void loadParamsForModel(item.id, target);
                        }}
                        onParamsOpen={(value) => loadParamsForModel(item.id, value)}
                        onOpen={() => {
                          void api.warmModelParams(item.id);
                          if (model) void loadParamsForModel(item.id, model);
                          if (models.length) return;
                          void useAppStore.getState().fetchProviderModels(item.id).then((catalog) => {
                            if (!catalog) return;
                            setModelsByProvider((prev) => ({
                              ...prev,
                              [item.id]: catalog.models ?? [],
                            }));
                          });
                        }}
                        placement="down"
                        variant="block"
                        loading={modelsLoading && models.length === 0}
                        recentModels={form.recentModelsByProvider?.[item.id]}
                        favoriteModels={form.favoriteModelsByProvider?.[item.id]}
                        onToggleFavorite={(value) =>
                          useAppStore.getState().toggleFavoriteModel(item.id, value)
                        }
                      />
                    </SettingRow>
                  );
                })}
              {modelsError ? <p className={styles.hint}>{modelsError}</p> : null}
            </SettingTable>
          )
        )}

        {section === "agent" && leaf === "builtin" && (
          <>
            <p className={styles.hint}>{t("settings.builtinDesc")}</p>
            <SettingTable>
              {form.builtinProviders.map((provider, index) => {
                const displayName =
                  provider.name.trim() ||
                  `${t("settings.builtinProviderUntitled")} ${index + 1}`;
                const update = (patchRow: Partial<BuiltinProviderConfig>) =>
                  patch(
                    "builtinProviders",
                    form.builtinProviders.map((p, i) =>
                      i === index ? { ...p, ...patchRow } : p,
                    ),
                  );
                const remove = () =>
                  patch(
                    "builtinProviders",
                    form.builtinProviders.filter((_, i) => i !== index),
                  );
                const nameLabel = `${displayName} · ${t("settings.builtinProviderName")}`;
                const urlLabel = `${displayName} · ${t("settings.builtinUrlTitle")}`;
                const keyLabel = `${displayName} · ${t("settings.builtinKeyTitle")}`;
                const modelsLabel = `${displayName} · ${t("settings.builtinModelsTitle")}`;
                return (
                  <Fragment key={provider.id}>
                    <SettingRow
                      layout="stack"
                      label={nameLabel}
                      hint={t("settings.builtinProviderNameHint")}
                      terms={[provider.name, displayName]}
                    >
                      <div className={styles.cwdPickRow}>
                        <input
                          type="text"
                          autoComplete="off"
                          value={provider.name}
                          onChange={(e) => update({ name: e.target.value })}
                          placeholder={t("settings.builtinProviderNamePlaceholder")}
                          aria-label={nameLabel}
                        />
                        <button
                          type="button"
                          className={styles.secondaryBtn}
                          onClick={remove}
                          aria-label={`${t("common.delete")} · ${displayName}`}
                        >
                          {t("common.delete")}
                        </button>
                      </div>
                    </SettingRow>
                    <SettingRow
                      layout="stack"
                      label={urlLabel}
                      hint={t("settings.builtinUrlHint")}
                      terms={[provider.url]}
                    >
                      <input
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={provider.url}
                        onChange={(e) => update({ url: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                        aria-label={urlLabel}
                      />
                    </SettingRow>
                    <SettingRow
                      layout="stack"
                      label={keyLabel}
                      hint={t("settings.builtinKeyHint")}
                    >
                      <input
                        type="password"
                        autoComplete="off"
                        value={provider.apiKey}
                        onChange={(e) => update({ apiKey: e.target.value })}
                        placeholder="sk-…"
                        aria-label={keyLabel}
                      />
                    </SettingRow>
                    <SettingRow
                      layout="stack"
                      label={`${displayName} · ${t("settings.builtinHeadersTitle")}`}
                      hint={t("settings.builtinHeadersHint", { sessionId: "{{sessionId}}" })}
                      terms={[provider.name]}
                    >
                      <BuiltinHeadersEditor
                        value={provider.headers ?? []}
                        onChange={(headers) => update({ headers })}
                      />
                    </SettingRow>
                    <SettingRow
                      layout="stack"
                      label={modelsLabel}
                      hint={t("settings.builtinModelsHint")}
                      terms={[provider.name]}
                    >
                      <BuiltinModelsEditor
                        endpointUrl={provider.url}
                        apiKey={provider.apiKey}
                        headers={provider.headers}
                        value={provider.models}
                        onChange={(models) => update({ models })}
                      />
                    </SettingRow>
                  </Fragment>
                );
              })}
              <SettingRow
                layout="stack"
                label={t("settings.builtinProvidersTitle")}
                hint={
                  form.builtinProviders.length
                    ? t("settings.builtinProvidersHint")
                    : t("settings.builtinProvidersEmpty")
                }
                terms={[
                  t("settings.builtinProviderAdd"),
                  t("settings.builtinProvidersHint"),
                  t("settings.builtinProvidersEmpty"),
                ]}
              >
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() =>
                    patch("builtinProviders", [
                      ...form.builtinProviders,
                      {
                        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                        name: "",
                        url: "",
                        apiKey: "",
                        models: [],
                      },
                    ])
                  }
                >
                  + {t("settings.builtinProviderAdd")}
                </button>
              </SettingRow>
            </SettingTable>

            <SettingTable>
              <SettingRow
                layout="stack"
                label={t("settings.builtinSkillPathsTitle")}
                hint={t("settings.builtinSkillPathsHint")}
                terms={[
                  t("settings.builtinSkillPathsTitle"),
                  t("settings.builtinSkillPathsHint"),
                  "SKILL.md",
                  ".agents/skills",
                  "~/.agents/skills",
                ]}
              >
                <textarea
                  className={styles.mcpFilesInput}
                  rows={3}
                  spellCheck={false}
                  value={skillPathsDraft ?? (form.builtinSkillPaths ?? []).join("\n")}
                  onChange={(e) => {
                    setSkillPathsDraft(e.target.value);
                    patch("builtinSkillPaths", parsePathLines(e.target.value));
                  }}
                  onBlur={() => setSkillPathsDraft(null)}
                  aria-label={t("settings.builtinSkillPathsTitle")}
                  placeholder={DEFAULT_BUILTIN_SKILL_PATHS.join("\n")}
                />
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => patch("builtinSkillPaths", [...DEFAULT_BUILTIN_SKILL_PATHS])}
                >
                  {t("settings.builtinSkillPathsReset")}
                </button>
              </SettingRow>
            </SettingTable>
          </>
        )}

        {section === "agent" && leaf === "advanced" && (
          <>
            <SettingTable>
              <SettingRow label={t("settings.defaultFolder")} controlClassName={styles.folderControl}>
                <div className={styles.cwdPickRow}>
                  <MiddleTruncate
                    className={styles.cwdPath}
                    text={form.defaultCwd || t("common.notSet")}
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setFolderBrowseTarget("defaultCwd");
                      setFolderBrowseOpen(true);
                    }}
                  >
                    {t("common.selectFolder")}
                  </button>
                  {form.defaultCwd ? (
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => patch("defaultCwd", "")}
                    >
                      {t("common.cancel")}
                    </button>
                  ) : null}
                </div>
              </SettingRow>

              <SettingRow
                label={t("settings.exportDir")}
                controlClassName={styles.folderControl}
                hint={t("settings.exportDirHint", {
                  path: form.exportDir || exportDirDefault || "…",
                })}
              >
                <div className={styles.cwdPickRow}>
                  <MiddleTruncate
                    className={styles.cwdPath}
                    text={form.exportDir || exportDirDefault || t("common.notSet")}
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setFolderBrowseTarget("exportDir");
                      setFolderBrowseOpen(true);
                    }}
                  >
                    {t("common.selectFolder")}
                  </button>
                  {form.exportDir ? (
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => patch("exportDir", "")}
                    >
                      {t("common.cancel")}
                    </button>
                  ) : null}
                </div>
              </SettingRow>

              <SettingRow label={t("settings.permissionPolicy")} terms={["разрешения"]}>
                <OptionPicker
                  variant="block"
                  placement="down"
                  menuTitle={t("settings.permissionPolicy")}
                  value={form.permissionPolicy}
                  onChange={(v) => patch("permissionPolicy", v as AppSettings["permissionPolicy"])}
                  options={[
                    { value: "always", label: t("settings.permissionAlways") },
                    { value: "prompt", label: t("settings.permissionPrompt") },
                    { value: "allowlist", label: t("settings.permissionAllowlist") },
                  ]}
                />
              </SettingRow>

              <SettingRow label={t("settings.resumeAgentContext")} hint={resumeHint}>
                <Toggle
                  checked={Boolean(form.resumeAgentContext)}
                  onChange={(v) => patch("resumeAgentContext", v)}
                  label={t("settings.resumeAgentContext")}
                />
              </SettingRow>
              <SettingRow label={t("settings.resetAgents")} hint={t("settings.resetAgentsHint")}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => {
                    void api.resetAgents().then(() => {
                      showToast(t("settings.resetAgentsDone"), { tone: "success" });
                    }).catch((err) => {
                      showToast(err instanceof Error ? err.message : String(err), { tone: "danger" });
                    });
                  }}
                >
                  {t("settings.resetAgents")}
                </button>
              </SettingRow>

              <SettingRow label={t("settings.multitask")} hint={t("settings.multitaskHint")}>
                <Toggle
                  checked={Boolean(form.multitask)}
                  onChange={(v) => patch("multitask", v)}
                  label={t("settings.multitask")}
                />
              </SettingRow>

              {showTerminalShell ? (
                <SettingRow label={t("settings.terminalShell")} hint={t("settings.terminalShellHint")}>
                  <div className={styles.actionChips}>
                    {(
                      [
                        ["cmd", t("settings.terminalShellCmd")],
                        ["powershell", t("settings.terminalShellPowerShell")],
                      ] as const
                    ).map(([id, label]) => {
                      const on = (form.terminalShell ?? "cmd") === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`${styles.actionChip}${on ? ` ${styles.actionChipOn}` : ""}`}
                          aria-pressed={on}
                          onClick={() => patch("terminalShell", id)}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </SettingRow>
              ) : null}
            </SettingTable>

            {form.permissionPolicy === "allowlist" && (
              <SearchGate terms={[t("settings.allowlistHint"), t("settings.permissionAllowlist")]}>
              <div className={styles.allowlistSection}>
                <p className={styles.fieldHint}>{t("settings.allowlistHint")}</p>
                {(form.permissionAllowlist ?? []).map((entry, i) => (
                  <div key={i} className={styles.allowlistRow}>
                    <input
                      className={styles.allowlistInput}
                      type="text"
                      value={entry}
                      placeholder="e.g. read_file, execute_command"
                      onChange={(e) => {
                        const next = [...(form.permissionAllowlist ?? [])];
                        next[i] = e.target.value;
                        patch("permissionAllowlist", next);
                      }}
                    />
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => {
                        const next = (form.permissionAllowlist ?? []).filter((_, j) => j !== i);
                        patch("permissionAllowlist", next);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => patch("permissionAllowlist", [...(form.permissionAllowlist ?? []), ""])}
                >
                  + {t("common.add")}
                </button>
              </div>
              </SearchGate>
            )}

            <SearchGate terms={[t("settings.apiKeys"), "api", ...apiKeyRows.flatMap((row) => [row.label, row.env])]}>
              <h2 className={styles.sectionHeading}>{highlightText(t("settings.apiKeys"), settingsQuery)}</h2>
              <SettingTable>
                {apiKeyRows.map((item) => {
                  const value = form[item.key] ?? "";
                  const hasValue = value.trim().length > 0;
                  return (
                    <SettingRow key={item.key} label={item.label} hint={item.env}>
                      <div className={styles.secretRow}>
                        <input
                          type="password"
                          value={value}
                          onChange={(e) => patch(item.key, e.target.value)}
                          autoComplete="off"
                          placeholder={item.placeholder || undefined}
                          aria-label={item.label}
                        />
                        <button
                          type="button"
                          className={styles.clearKeyBtn}
                          disabled={!hasValue}
                          title={t("settings.removeKey")}
                          onClick={() => void clearApiKey(item.key)}
                        >
                          {t("common.delete")}
                        </button>
                      </div>
                    </SettingRow>
                  );
                })}
              </SettingTable>
            </SearchGate>

            <SearchGate
              terms={[
                t("settings.cliAndPermissions"),
                t("settings.agentAdvancedDesc"),
                ...adapters.flatMap((a) => [a.label, a.defaultCommand, ...a.defaultArgs]),
              ]}
            >
            <details className={styles.cliDisclosure}>
              <summary>{highlightText(t("settings.cliAndPermissions"), settingsQuery)}</summary>
              <div className={styles.cliDisclosureBody}>
                <p className={styles.fieldHint}>{highlightText(t("settings.agentAdvancedDesc"), settingsQuery)}</p>
                <SettingTable>
                  {adapters
                    .filter((a) => a.custom !== true && a.commandField)
                    .map((a) => {
                    const command = String(
                      (form as unknown as Record<string, unknown>)[a.commandField] ?? "",
                    );
                    const args = (form as unknown as Record<string, unknown>)[a.argsField];
                    const apiKeyField = a.apiKeyField;
                    const apiKey = apiKeyField
                      ? String((form as unknown as Record<string, unknown>)[apiKeyField] ?? "")
                      : "";
                    return (
                      <SettingRow key={a.id} layout="stack" label={a.label} terms={[a.label, a.defaultCommand]}>
                        <div className={styles.cliFields}>
                          <input
                            value={command}
                            onChange={(e) => patchAny(a.commandField, e.target.value)}
                            placeholder={a.defaultCommand}
                          />
                          <input
                            value={Array.isArray(args) ? args.join(" ") : ""}
                            onChange={(e) =>
                              patchAny(a.argsField, e.target.value.split(/\s+/).filter(Boolean))
                            }
                            placeholder={a.defaultArgs.join(" ")}
                          />
                          {apiKeyField ? (
                            <input
                              value={apiKey}
                              onChange={(e) => patchAny(apiKeyField, e.target.value)}
                              placeholder={a.envApiKeyName ?? "API key"}
                            />
                          ) : null}
                        </div>
                      </SettingRow>
                    );
                  })}
                </SettingTable>
              </div>
            </details>
            </SearchGate>
          </>
        )}

        {section === "agent" && leaf === "mcp" && (
          <>
            <SearchGate terms={[t("settings.mcpApplyHint"), "mcp"]}>
              <div className={styles.mcpApplyNote} role="note">
                {t("settings.mcpApplyHint")}
              </div>
            </SearchGate>
            <SettingTable>
              {mcpServers.map((server) => (
                <SettingRow
                  key={server.id}
                  terms={[
                    server.name,
                    mcpServerEndpoint(server),
                    t(mcpTypeMessageKey(server.type)),
                  ]}
                  label={
                    <span className={styles.mcpRowMetaInline}>
                      {server.enabled ? (
                        <span
                          className={`${styles.mcpStatusDot} ${
                            mcpStatus[server.id] === true
                              ? styles.mcpStatusDotOk
                              : mcpStatus[server.id] === false
                                ? styles.mcpStatusDotBad
                                : styles.mcpStatusDotPending
                          }`}
                          title={
                            mcpStatus[server.id] === true
                              ? t("common.connected")
                              : mcpStatus[server.id] === false
                                ? t("common.notConnected")
                                : t("common.checking")
                          }
                          aria-hidden
                        />
                      ) : null}
                      <strong>{server.name}</strong>
                      <span className={styles.mcpRowType}>
                        {t(mcpTypeMessageKey(server.type))}
                      </span>
                    </span>
                  }
                  hint={
                    <span className={styles.mcpRowDetail}>
                      {mcpServerEndpoint(server)}
                      {server.type === "remote" && server.token ? (
                        <span className={styles.mcpRowToken}> · {t("settings.mcpTokenSet")}</span>
                      ) : null}
                    </span>
                  }
                >
                  <Toggle
                    checked={Boolean(server.enabled)}
                    onChange={(v) => updateMcp(server.id, { enabled: v })}
                    label={server.enabled ? t("settings.enabled") : t("settings.disabled")}
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() =>
                      setMcpDraft({
                        ...server,
                        remoteConfig: mcpRemoteConfigDraft(server),
                        envConfig: mcpEnvConfigDraft(server),
                      })
                    }
                  >
                    {t("common.edit")}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => removeMcp(server.id)}
                  >
                    {t("common.delete")}
                  </button>
                </SettingRow>
              ))}
              {mcpServers.length === 0 ? (
                <SettingRow label={t("settings.mcpHint")} hint={t("settings.mcpEmptyHint")} />
              ) : null}
            </SettingTable>

            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() =>
                setMcpDraft({
                  id: "",
                  name: "",
                  enabled: true,
                  type: "local",
                  url: "",
                  remoteConfig: '{\n  "headers": {\n    "Authorization": "Bearer "\n  }\n}',
                })
              }
            >
              + {t("settings.mcpAdd")}
            </button>

            {mcpDraft && (
              <McpServerForm
                draft={mcpDraft}
                onChange={setMcpDraft}
                onSave={saveMcp}
                onCancel={() => setMcpDraft(null)}
              />
            )}

            <SettingTable>
              <SettingRow
                layout="stack"
                label={t("settings.mcpFolderFilesTitle")}
                hint={t("settings.mcpFolderFilesHint")}
                terms={[
                  t("settings.mcpFolderFilesTitle"),
                  t("settings.mcpFolderFilesHint"),
                  ".omp/mcp.json",
                  ".cursor/mcp.json",
                  ".agents/mcp.json",
                  "mcp.json",
                ]}
              >
                <textarea
                  className={styles.mcpFilesInput}
                  rows={4}
                  spellCheck={false}
                  value={mcpFilesDraft ?? (form.mcpProjectFiles ?? []).join("\n")}
                  onChange={(e) => {
                    setMcpFilesDraft(e.target.value);
                    patch("mcpProjectFiles", parsePathLines(e.target.value));
                  }}
                  onBlur={() => setMcpFilesDraft(null)}
                  aria-label={t("settings.mcpFolderFilesTitle")}
                  placeholder={DEFAULT_MCP_PROJECT_FILES.join("\n")}
                />
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => patch("mcpProjectFiles", [...DEFAULT_MCP_PROJECT_FILES])}
                >
                  {t("settings.mcpFolderFilesReset")}
                </button>
              </SettingRow>
            </SettingTable>
          </>
        )}

        {section === "agent" && leaf === "diagnostics" && (
          <>
            <SettingTable>
              <SettingRow
                label={t("diagnostics.deepLogging")}
                hint={t("diagnostics.deepLoggingHint")}
              >
                <Toggle
                  checked={form.diagnosticsDeepLogging === true}
                  onChange={(v) => {
                    patch("diagnosticsDeepLogging", v);
                    void saveSettings({ diagnosticsDeepLogging: v });
                  }}
                  label={t("diagnostics.deepLogging")}
                />
              </SettingRow>

              <SettingRow label={t("diagnostics.folder")} controlClassName={styles.folderControl}>
                <div className={styles.cwdPickRow}>
                  <MiddleTruncate
                    className={styles.cwdPath}
                    text={
                      form.diagnosticsDir ||
                      diagDirResolved ||
                      diagDirDefault ||
                      t("common.notSet")
                    }
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setFolderBrowseTarget("diagnosticsDir");
                      setFolderBrowseOpen(true);
                    }}
                  >
                    {t("common.selectFolder")}
                  </button>
                  {form.diagnosticsDir ? (
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => patch("diagnosticsDir", "")}
                    >
                      {t("diagnostics.useDefault")}
                    </button>
                  ) : null}
                </div>
              </SettingRow>

              <SettingRow
                label={t("diagnostics.chat")}
                hint={
                  sessions.length === 0 ? t("diagnostics.noChats") : t("diagnostics.chatHint")
                }
              >
                <OptionPicker
                  value={diagSessionId ?? ""}
                  placement="down"
                  variant="block"
                  menuTitle={t("diagnostics.chat")}
                  placeholder={t("diagnostics.chatNone")}
                  emptyLabel={t("diagnostics.noChats")}
                  onChange={(value) => setDiagSessionId(value)}
                  options={[
                    { value: "", label: t("diagnostics.chatNone") },
                    ...sessions.map((s) => ({
                      value: s.id,
                      label: truncateSessionTitle(s.title || s.id.slice(0, 8), 44),
                      hint:
                        s.id === activeSessionId
                          ? `${s.provider} · ${t("diagnostics.chatActive")}`
                          : s.provider,
                    })),
                  ]}
                />
              </SettingRow>
            </SettingTable>

            <div className={styles.sectionBlock}>
            <SearchGate terms={[t("diagnostics.createNow"), t("diagnostics.saving"), t("common.refresh"), t("diagnostics.savedTo")]}>
            <div className={styles.diagActions}>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={diagBusy}
                onClick={() => {
                  void (async () => {
                    setDiagBusy(true);
                    setDiagMessage(null);
                    try {
                      const dump = await submitDiagnosticsDump({
                        reason: "manual",
                        sessionId: diagSessionId ?? "",
                      });
                      setDiagMessage(t("diagnostics.savedTo", { path: dump.path }));
                      await refreshDiagnostics();
                    } catch (err) {
                      setDiagMessage(err instanceof Error ? err.message : String(err));
                    } finally {
                      setDiagBusy(false);
                    }
                  })();
                }}
              >
                {diagBusy ? t("diagnostics.saving") : t("diagnostics.createNow")}
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={diagLoading}
                onClick={() => void refreshDiagnostics()}
              >
                {t("common.refresh")}
              </button>
              {diagMessage ? <span className={styles.hint}>{diagMessage}</span> : null}
            </div>
            </SearchGate>
            </div>

            <div className={styles.sectionBlock}>
            <SearchGate terms={[t("diagnostics.dumpsTitle"), t("diagnostics.dumpsHint"), t("diagnostics.empty"), t("diagnostics.copyJson")]}>
              <h2 className={styles.sectionHeading}>{highlightText(t("diagnostics.dumpsTitle"), settingsQuery)}</h2>
            <p className={styles.fieldHint}>{t("diagnostics.dumpsHint")}</p>
            {diagLoading && !diagItems.length ? (
              <p className={styles.hint}>{t("common.loading")}</p>
            ) : null}
            {!diagLoading && diagItems.length === 0 ? (
              <p className={styles.hint}>{t("diagnostics.empty")}</p>
            ) : null}
            <ul className={styles.diagList} ref={diagScrollRef}>
              {diagShown.map((item) => (
                <li key={item.id} className={styles.diagCard}>
                  <div className={styles.diagCardMain}>
                    <div className={styles.diagCardTop}>
                      <span className={styles.diagReason}>{item.reason}</span>
                      <span className={styles.diagItemMeta}>
                        {new Date(item.createdAt).toLocaleString()} ·{" "}
                        {Math.max(1, Math.round(item.size / 1024))} KB
                      </span>
                    </div>
                    <p className={styles.diagPath} title={item.path}>
                      {item.fileName}
                    </p>
                  </div>
                  <div className={styles.diagCardActions}>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      disabled={diagCopyId === item.id}
                      onClick={() => {
                        void (async () => {
                          setDiagCopyId(item.id);
                          setDiagMessage(null);
                          try {
                            const full = await getDiagnosticsDump(item.id);
                            await navigator.clipboard.writeText(
                              JSON.stringify(full.payload, null, 2),
                            );
                            setDiagMessage(t("diagnostics.copied"));
                          } catch (err) {
                            setDiagMessage(err instanceof Error ? err.message : String(err));
                          } finally {
                            setDiagCopyId(null);
                          }
                        })();
                      }}
                    >
                      {diagCopyId === item.id ? t("diagnostics.copying") : t("diagnostics.copyJson")}
                    </button>
                    <button
                      type="button"
                      className={styles.diagDelete}
                      aria-label={t("common.delete")}
                      onClick={() => {
                        void (async () => {
                          try {
                            await api.deleteDiagnosticsDump(item.id);
                            await refreshDiagnostics();
                          } catch (err) {
                            setDiagMessage(err instanceof Error ? err.message : String(err));
                          }
                        })();
                      }}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                </li>
              ))}
              {diagHasMore ? (
                <li ref={diagMoreRef} className={styles.diagMore} aria-hidden />
              ) : null}
            </ul>
            </SearchGate>
            </div>

            <div className={styles.sectionBlock}>
            <SearchGate terms={[t("diagnostics.exportChatsTitle"), t("diagnostics.exportChatsHint"), t("diagnostics.exportChatsDownload"), t("diagnostics.exportChatsSave"), t("diagnostics.exportChatsSavedTo")]}>
              <h2 className={styles.sectionHeading}>{highlightText(t("diagnostics.exportChatsTitle"), settingsQuery)}</h2>
              <p className={styles.fieldHint}>{t("diagnostics.exportChatsHint")}</p>
              <div className={styles.diagActions}>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={chatsExportBusy}
                  onClick={() => {
                    void (async () => {
                      setChatsExportBusy(true);
                      setChatsExportMessage(null);
                      try {
                        await api.downloadChatsExport("builtin");
                        setChatsExportMessage(t("diagnostics.exportChatsDownloaded"));
                      } catch (err) {
                        setChatsExportMessage(err instanceof Error ? err.message : String(err));
                      } finally {
                        setChatsExportBusy(false);
                      }
                    })();
                  }}
                >
                  {chatsExportBusy
                    ? t("diagnostics.exportChatsSaving")
                    : t("diagnostics.exportChatsDownload")}
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={chatsExportBusy}
                  onClick={() => {
                    void (async () => {
                      setChatsExportBusy(true);
                      setChatsExportMessage(null);
                      try {
                        const res = await api.saveChatsExportToServer("builtin");
                        setChatsExportMessage(
                          t("diagnostics.exportChatsSavedTo", { count: res.count, path: res.path }),
                        );
                      } catch (err) {
                        setChatsExportMessage(err instanceof Error ? err.message : String(err));
                      } finally {
                        setChatsExportBusy(false);
                      }
                    })();
                  }}
                >
                  {chatsExportBusy
                    ? t("diagnostics.exportChatsSaving")
                    : t("diagnostics.exportChatsSave")}
                </button>
              </div>
              {chatsExportMessage ? (
                <p className={styles.hint}>{chatsExportMessage}</p>
              ) : exportDirDefault ? (
                <p className={styles.hint}>
                  {t("diagnostics.exportChatsServerHint", { path: exportDirDefault })}
                </p>
              ) : null}
            </SearchGate>
            </div>
          </>
        )}

        {section === "agent" && leaf === "remote" && (
          <>
            <SettingTable>
              <SettingRow
                layout="stack"
                label={t("settings.remoteKeyTitle")}
                hint={t("settings.remoteKeyHint")}
                terms={[t("settings.remoteKeyTitle"), t("settings.remoteKeyHint"), t("settings.remoteStep4Body")]}
              >
                <div className={styles.remoteKeyRow}>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.remoteAccessKey ?? ""}
                    onChange={(e) => patch("remoteAccessKey", e.target.value)}
                    placeholder={t("settings.remoteKeyPlaceholder")}
                    aria-label={t("settings.remoteKeyTitle")}
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
                      const bytes = new Uint8Array(8);
                      crypto.getRandomValues(bytes);
                      const next = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
                      patch("remoteAccessKey", next);
                      void saveSettings({ remoteAccessKey: next }).then(() => {
                        showToast(t("settings.saved"), { tone: "success", id: "settings-saved" });
                      });
                    }}
                  >
                    {t("settings.remoteKeyGenerate")}
                  </button>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    disabled={
                      !(form.remoteAccessKey ?? "").trim() ||
                      (form.remoteAccessKey ?? "") === (settings.remoteAccessKey ?? "")
                    }
                    onClick={() => {
                      const next = (form.remoteAccessKey ?? "").trim();
                      if (!next) return;
                      patch("remoteAccessKey", next);
                      void saveSettings({ remoteAccessKey: next }).then(() => {
                        showToast(t("settings.saved"), { tone: "success", id: "settings-saved" });
                      });
                    }}
                  >
                    {t("common.save")}
                  </button>
                  {(form.remoteAccessKey ?? "").trim() ? (
                    <button
                      type="button"
                      className={styles.clearKeyBtn}
                      onClick={() => {
                        patch("remoteAccessKey", "");
                        void saveSettings({ remoteAccessKey: "" });
                      }}
                    >
                      {t("common.delete")}
                    </button>
                  ) : null}
                </div>
              </SettingRow>
              <SettingRow label={t("settings.remoteStep1Title")} hint={t("settings.remoteStep1Body")} />
              <SettingRow label={t("settings.remoteStep2Title")} hint={<>
                {t("settings.remoteStep2Body")}
                <br />
                {t("settings.remoteStep2HowIp")}
              </>} />
              <SettingRow label={t("settings.remoteStep3Title")} hint={t("settings.remoteStep3Body")}>
                <div className={styles.remoteUrlRow}>
                  <input value={pageUrl} readOnly title={pageUrl || undefined} />
                  <button type="button" className={styles.secondaryBtn} onClick={() => void copyUrl()}>
                    {copied ? t("settings.remoteCopied") : t("settings.remoteCopy")}
                  </button>
                </div>
              </SettingRow>
              <SettingRow label={t("settings.remoteStep4Title")} hint={t("settings.remoteStep4Body")} />
            </SettingTable>
            <SearchGate
              terms={[
                t("settings.remoteTipTitle"),
                t("settings.remoteTipLocalhost"),
                t("settings.remoteTipSameNetwork"),
                t("settings.remoteTipFirewall"),
                t("settings.remoteTipHttp"),
                t("settings.remoteTipInstall"),
                t("settings.remoteTipKey"),
              ]}
            >
            <div className={styles.remoteTipsBlock}>
              <h2 className={styles.sectionHeading}>{highlightText(t("settings.remoteTipTitle"), settingsQuery)}</h2>
              <ul className={styles.remoteTips}>
                <li>{t("settings.remoteTipLocalhost")}</li>
                <li>{t("settings.remoteTipSameNetwork")}</li>
                <li>{t("settings.remoteTipFirewall")}</li>
                <li>{t("settings.remoteTipHttp")}</li>
                <li>{t("settings.remoteTipInstall")}</li>
                <li>{t("settings.remoteTipKey")}</li>
              </ul>
            </div>
            </SearchGate>
          </>
        )}

        {(section === "interface" ||
          (section === "agent" && leaf !== "connect" && leaf !== "remote")) && (
          <div className={styles.footerBar}>
            <button type="submit">{t("common.save")}</button>
          </div>
        )}
        </div>)}
        </SettingsSearchProvider>
      </form>
      <ServerFolderBrowseDialog
        open={folderBrowseOpen}
        initialPath={
          folderBrowseTarget === "diagnosticsDir"
            ? form.diagnosticsDir || diagDirDefault || undefined
            : folderBrowseTarget === "exportDir"
              ? form.exportDir || exportDirDefault || undefined
              : form.defaultCwd || undefined
        }
        onClose={() => setFolderBrowseOpen(false)}
        onSelect={(path) => patch(folderBrowseTarget, path)}
      />
    </div>
  );
}
