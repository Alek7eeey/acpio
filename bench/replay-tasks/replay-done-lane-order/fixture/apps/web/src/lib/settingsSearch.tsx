import { createContext, useContext, type ReactNode } from "react";
import type { TranslateFn } from "@acpio/i18n";
import type { AdapterMetaDto } from "@acpio/shared";
import type { SettingsLeaf } from "./settingsNav";
import searchStyles from "./settingsSearch.module.css";

/**
 * Settings search: a shared query string (kept in the app store so the
 * sidebar tree and the page content filter against the same value) plus
 * helpers for matching and highlighting.
 *
 * Query semantics: case-insensitive, whitespace-separated terms AND together;
 * a row/leaf matches when every term appears somewhere in its searchable
 * text.
 */

type SettingsSearchState = { query: string; filtering: boolean };
const SettingsSearchContext = createContext<SettingsSearchState>({
  query: "",
  filtering: false,
});

export function SettingsSearchProvider({
  query,
  filtering,
  children,
}: {
  query: string;
  /** Narrow SettingRow/SearchGate content to the query. Off while a specific
   *  section is open, so the full section renders (query still highlighted). */
  filtering?: boolean;
  children: ReactNode;
}) {
  return (
    <SettingsSearchContext.Provider value={{ query, filtering: filtering ?? false }}>
      {children}
    </SettingsSearchContext.Provider>
  );
}

function splitTerms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
}

/** Wrap every query-term occurrence in <mark> (styled accent chip). */
export function highlightText(text: string, query: string): ReactNode {
  const terms = splitTerms(query);
  if (terms.length === 0) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let best: { start: number; end: number } | null = null;
    for (const term of terms) {
      const idx = lower.indexOf(term, cursor);
      if (idx >= 0 && (!best || idx < best.start)) {
        best = { start: idx, end: idx + term.length };
      }
    }
    if (!best) break;
    if (best.start > cursor) parts.push(text.slice(cursor, best.start));
    parts.push(
      <mark key={best.start} className={searchStyles.mark}>
        {text.slice(best.start, best.end)}
      </mark>,
    );
    cursor = best.end;
  }
  parts.push(text.slice(cursor));
  return parts;
}

export function useSettingsSearch() {
  const { query, filtering } = useContext(SettingsSearchContext);
  const terms = splitTerms(query);
  const active = filtering && terms.length > 0;

  const matches = (text: string): boolean => {
    if (!active) return true;
    const hay = text.toLowerCase();
    return terms.every((term) => hay.includes(term));
  };

  const highlight = (text: string): ReactNode => highlightText(text, query);

  return { query, active, terms, matches, highlight };
}

/** Every query term must appear somewhere in the combined texts. */
export function matchAny(texts: string[], q: string): boolean {
  const terms = splitTerms(q);
  if (terms.length === 0) return true;
  const hay = texts.join(" ").toLowerCase();
  return terms.every((term) => hay.includes(term));
}

/**
 * Hides its children while a search is active — either unconditionally
 * (hideWhenSearching, e.g. the chat preview mock) or unless the given terms
 * match (e.g. auxiliary blocks around filterable rows).
 */
export function SearchGate({
  terms,
  hideWhenSearching = false,
  children,
}: {
  terms?: string[];
  hideWhenSearching?: boolean;
  children: ReactNode;
}) {
  const { query, active } = useSettingsSearch();
  if (!active) return <>{children}</>;
  if (hideWhenSearching) return null;
  if (terms && matchAny(terms, query)) return <>{children}</>;
  return null;
}

/**
 * Per-leaf search index: what a settings section is about, independent of
 * the currently open leaf. Drives the sidebar tree filter (and the "also
 * found in" chips). Rows themselves filter live against their own text.
 */
export function settingsSearchIndex(
  t: TranslateFn,
  adapters: AdapterMetaDto[] = [],
): Record<SettingsLeaf, string[]> {
  // Names/commands of the harnesses the user keeps on — a switched-off agent
  // must not be findable anywhere in the settings tree.
  const providerTerms = adapters.flatMap((a) => [a.id, a.label, a.defaultCommand]);
  const base: Record<SettingsLeaf, string[]> = {
    connect: [
      t("settings.connection"),
      t("settings.agentConnectTitle"),
      t("settings.agentConnectDesc"),
      t("settings.defaultAgent"),
      t("settings.defaultAgentHint"),
      ...providerTerms,
    ],
    model: [
      t("settings.modelSection"),
      t("settings.agentModelTitle"),
      ...adapters.map((a) => t("settings.defaultModelFor", { agent: a.label })),
      t("common.noAgentsOnline"),
      t("settings.auto"),
    ],
    builtin: [
      t("settings.builtinTitle"),
      t("settings.builtinDesc"),
      t("settings.builtinHint"),
      t("settings.builtinProvidersTitle"),
      t("settings.builtinProviderAdd"),
      t("settings.builtinProviderName"),
      t("settings.builtinUrlTitle"),
      t("settings.builtinUrlHint"),
      t("settings.builtinKeyTitle"),
      t("settings.builtinKeyHint"),
      t("settings.builtinModelsTitle"),
      t("settings.builtinModelsHint"),
      t("settings.builtinModelsFetch"),
      t("settings.builtinModelsAdd"),
      "llm",
      "api",
      "provider",
      "провайдер",
    ],
    advanced: [
      t("settings.advanced"),
      t("settings.agentAdvancedTitle"),
      t("settings.agentAdvancedDesc"),
      t("settings.defaultFolder"),
      t("settings.exportDir"),
      t("settings.permissionPolicy"),
      t("settings.permissionAlways"),
      t("settings.permissionPrompt"),
      t("settings.permissionAllowlist"),
      t("settings.allowlistHint"),
      // Morphological variant of "Политика разрешений" (genitive plural).
      "разрешения",
      t("settings.resumeAgentContext"),
      t("settings.multitask"),
      t("settings.apiKeys"),
      "api",
      t("settings.cliAndPermissions"),
      t("settings.terminalShell"),
      t("settings.terminalShellCmd"),
      t("settings.terminalShellPowerShell"),
      // Only the harnesses the user keeps enabled are searchable.
      ...providerTerms,
    ],
    mcp: [
      t("settings.mcpTitle"),
      "mcp",
      t("settings.mcpAdd"),
      t("settings.mcpLocal"),
      t("settings.mcpRemote"),
      t("settings.mcpStdio"),
      t("settings.mcpApplyHint"),
      t("settings.mcpHint"),
    ],
    diagnostics: [
      t("settings.diagnostics"),
      t("settings.diagnosticsTitle"),
      t("settings.diagnosticsDesc"),
      t("diagnostics.folder"),
      t("diagnostics.chat"),
      t("diagnostics.deepLogging"),
      t("diagnostics.dumpsTitle"),
      t("diagnostics.dumpsHint"),
      t("diagnostics.createNow"),
      t("diagnostics.copyJson"),
    ],
    remote: [
      t("settings.remoteAccess"),
      t("settings.remoteAccessTitle"),
      t("settings.remoteAccessDesc"),
      t("settings.remoteStep1Title"),
      t("settings.remoteStep2Title"),
      t("settings.remoteStep3Title"),
      t("settings.remoteStep4Title"),
      t("settings.remoteKeyTitle"),
      t("settings.remoteTipTitle"),
      t("settings.remoteCopy"),
      t("settings.remoteTipKey"),
    ],
    appearance: [
      t("settings.appearance"),
      t("settings.sidebarCollapse"),
      t("settings.sidebarCollapseHint"),
      t("settings.sidebarCollapseFull"),
      t("settings.sidebarCollapseRail"),
      t("settings.fontFamily"),
      t("settings.fontSize"),
      "figtree",
      "inter",
      t("settings.fontSystem"),
      t("settings.showBootSplash"),
    ],
    colors: [
      t("settings.colors"),
      t("settings.colorsDesc"),
      t("settings.lightScheme"),
      t("settings.darkScheme"),
      t("settings.customScheme"),
      t("settings.customAccent"),
    ],
    voice: [
      t("settings.voice"),
      t("settings.voiceTitle"),
      t("settings.voiceDesc"),
      "tts",
      t("settings.ttsVoiceGender"),
      t("settings.ttsTest"),
      t("settings.ttsNaturalHint"),
      t("settings.ttsOpenWindowsSpeech"),
    ],
    chat: [
      t("settings.chat"),
      t("settings.chatTitle"),
      t("settings.chatDesc"),
      t("settings.chatActions"),
      t("settings.chatMetaChips"),
      t("settings.chatMetaChipGitBranch"),
      t("settings.chatMetaChipGitChanges"),
      t("settings.chatComposerButtons"),
      t("settings.chatTreeElements"),
      t("settings.chatTreeRecentLimit"),
      t("settings.chatTreeMenuTitle"),
      t("settings.chatEnterToSend"),
      t("settings.chatShowMessageTime"),
      t("settings.chatAgentTurnTimeline"),
      t("settings.chatSplit"),
      t("settings.chatToolbarStyle"),
      t("settings.chatGitBranchPosition"),
      t("settings.chatChipFolder"),
      t("settings.chatChipBranch"),
      t("settings.chatChipChanges"),
      t("settings.chatChipChangesMetrics"),
      t("settings.chatChipContext"),
      t("settings.chatAdvanced"),
      t("settings.chatBehavior"),
      t("settings.chatIntro"),
    ],
  };
  const hints = settingsRowHints(t);
  const out = {} as Record<SettingsLeaf, string[]>;
  (Object.keys(base) as SettingsLeaf[]).forEach((leaf) => {
    out[leaf] = Array.from(new Set([...base[leaf], ...(hints[leaf] ?? [])]));
  });
  return out;
}

/**
 * Row-level hint/description text per leaf. Indexed so searches match the
 * explanatory copy shown under each setting, not just titles.
 */
function settingsRowHints(t: TranslateFn): Record<SettingsLeaf, string[]> {
  return {
    connect: [],
    model: [],
    builtin: [
      t("settings.builtinUrlHint"),
      t("settings.builtinKeyHint"),
      t("settings.builtinModelsHint"),
      t("settings.builtinProvidersHint"),
      t("settings.builtinProvidersEmpty"),
      t("settings.builtinProviderNameHint"),
    ],
    advanced: [
      t("settings.exportDirHint", { path: "…" }),
      t("settings.resumeAgentContextHint"),
      t("settings.multitaskHint"),
      t("settings.allowlistHint"),
      t("settings.cliAndPermissions"),
      t("settings.terminalShell"),
      t("settings.terminalShellCmd"),
      t("settings.terminalShellPowerShell"),
      t("settings.terminalShellHint"),
    ],
    mcp: [t("settings.mcpEmptyHint"), t("settings.mcpApplyHint")],
    diagnostics: [
      t("diagnostics.folderHint", { path: "…" }),
      t("diagnostics.chatHint"),
      t("diagnostics.deepLoggingHint"),
      t("diagnostics.noChats"),
      t("diagnostics.dumpsHint"),
    ],
    remote: [
      t("settings.remoteStep1Body"),
      t("settings.remoteStep2Body"),
      t("settings.remoteStep2HowIp"),
      t("settings.remoteStep3Body"),
      t("settings.remoteTipLocalhost"),
      t("settings.remoteTipSameNetwork"),
    ],
    appearance: [
      t("settings.sidebarCollapseHint"),
      t("settings.fontFamilyHint"),
      t("settings.fontSizeHint"),
      t("settings.showBootSplashHint"),
    ],
    colors: [t("settings.lightSchemeHint"), t("settings.darkSchemeHint")],
    voice: [t("settings.ttsVoiceGenderHint"), t("settings.ttsNaturalHint"), t("settings.ttsOpenWindowsSpeech")],
    chat: [
      t("settings.chatIntro"),
      t("settings.chatActionsHint"),
      t("settings.chatMetaChipsHint"),
      t("settings.chatComposerButtonsHint"),
      t("settings.chatTreeElementsHint"),
      t("settings.chatTreeRecentLimitHint"),
      t("settings.chatTreeMenuHint"),
      t("settings.chatEnterToSendHint"),
      t("settings.chatShowMessageTimeHint"),
      t("settings.chatAgentTurnTimelineHint"),
      t("settings.chatSplitHint"),
      t("settings.chatToolbarStyleHint"),
    ],
  };
}
