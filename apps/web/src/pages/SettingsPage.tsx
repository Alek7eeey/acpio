import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  migrateModelParamValues,
  type AgentProbeResult,
  type AgentProvider,
  type AppSettings,
  type ChatActionId,
  type ChatMetaChipId,
  type DiagnosticsDumpMeta,
  type McpServerConfig,
  type ModelParamDto,
} from "@acprocess/shared";
import { api } from "../lib/api";
import { parseSettingsSearch } from "../lib/settingsNav";
import { useT } from "../lib/i18n";
import { adapterMeta, useAppStore } from "../lib/store";
import { ModelPicker } from "../components/ModelPicker";
import { OptionPicker } from "../components/OptionPicker";
import { ServerFolderBrowseDialog } from "../components/ServerFolderBrowseDialog";
import { SettingRow, SettingTable, Toggle } from "../components/SettingRow";
import { ChatSettingsPreview } from "../components/ChatSettingsPreview";
import { getDiagnosticsDump, submitDiagnosticsDump } from "../lib/diagnostics";
import { startReadAloud, stopReadAloud } from "../lib/tts";
import { DARK_SCHEMES, LIGHT_SCHEMES, SYSTEM_SWATCH } from "../lib/themeSchemes";
import styles from "./SettingsPage.module.css";

const PROVIDER_IDS = ["cursor", "omp"] as const satisfies readonly AgentProvider[];

/** Canonical display order for message actions and composer chips. */
const CHAT_ACTION_ORDER: ChatActionId[] = [
  "copy",
  "edit",
  "like",
  "dislike",
  "share",
  "regenerate",
  "readAloud",
];
const CHAT_CHIP_ORDER: ChatMetaChipId[] = ["folder", "thoughts", "mcp"];

/** Toggle a value in a canonical-ordered array (re-adds in the right slot). */
function toggleInOrder<T>(current: T[], id: T, order: T[]): T[] {
  const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
  return order.filter((v) => next.includes(v));
}

/** Command value a provider's settings form carries (adapter-declared field). */
function adapterCommandFor(form: AppSettings, provider: AgentProvider): string {
  const meta = adapterMeta(provider);
  if (!meta) return provider === "cursor" ? form.cursorCommand ?? "agent" : form.ompCommand ?? "omp";
  const stored = (form as unknown as Record<string, unknown>)[meta.commandField];
  return typeof stored === "string" && stored.trim() ? stored.trim() : meta.defaultCommand;
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

export function SettingsPage() {
  const t = useT();
  const adapters = useAppStore((s) => s.adapters);
  /** CLI/args form rows: every registered adapter, with built-in fallback. */
  const cliFormAdapters = useMemo(() => {
    if (adapters.length) return adapters;
    return [
      {
        id: "cursor",
        label: "Cursor",
        commandField: "cursorCommand",
        argsField: "cursorArgs",
        apiKeyField: "cursorApiKey",
        envApiKeyName: "CURSOR_API_KEY",
        defaultCommand: "agent",
        defaultArgs: ["acp"],
      },
      {
        id: "omp",
        label: "OMP",
        commandField: "ompCommand",
        argsField: "ompArgs",
        defaultCommand: "omp",
        defaultArgs: ["acp"],
      },
    ];
  }, [adapters]);
  const providers = useMemo(() => {
    const registered = adapters.length
      ? adapters.map((a) => ({
          id: a.id,
          title: a.label,
          description: t(a.descriptionKey as "settings.cursorDesc" | "settings.ompDesc"),
        }))
      : PROVIDER_IDS.map((id) => ({
          id,
          title: id === "cursor" ? "Cursor" : "OMP",
          description: id === "cursor" ? t("settings.cursorDesc") : t("settings.ompDesc"),
        }));
    return registered;
  }, [adapters, t]);
  const location = useLocation();
  const { section, leaf } = useMemo(
    () => parseSettingsSearch(location.search),
    [location.search],
  );
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [form, setForm] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);
  const [probes, setProbes] = useState<Partial<Record<AgentProvider, AgentProbeResult>>>({});
  const [probingId, setProbingId] = useState<AgentProvider | null>(null);
  const [folderBrowseOpen, setFolderBrowseOpen] = useState(false);
  const [folderBrowseTarget, setFolderBrowseTarget] = useState<
    "defaultCwd" | "diagnosticsDir" | "exportDir"
  >("defaultCwd");
  const [copied, setCopied] = useState(false);
  const [connectingId, setConnectingId] = useState<AgentProvider | null>(null);
  const [mcpDraft, setMcpDraft] = useState<McpServerConfig | null>(null);
  const [mcpStatus, setMcpStatus] = useState<Record<string, boolean>>({});
  const [ttsHasNatural, setTtsHasNatural] = useState(false);
  const [ttsTestEngine, setTtsTestEngine] = useState<"idle" | "browser">("idle");
  const [models, setModels] = useState<Array<{ value: string; name: string }>>([]);
  const [modelParams, setModelParams] = useState<ModelParamDto[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [stableParams, setStableParams] = useState<ModelParamDto[]>([]);
  const [diagDirDefault, setDiagDirDefault] = useState("");
  const [diagDirResolved, setDiagDirResolved] = useState("");
  const [exportDirDefault, setExportDirDefault] = useState("");
  const [diagItems, setDiagItems] = useState<DiagnosticsDumpMeta[]>([]);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagMessage, setDiagMessage] = useState<string | null>(null);
  const [diagSessionId, setDiagSessionId] = useState<string | null>(
    () => useAppStore.getState().activeSessionId,
  );
  const [diagCopyId, setDiagCopyId] = useState<string | null>(null);
  const paramsCacheRef = useRef(new Map<string, ModelParamDto[]>());

  // NOTE: removed the `useEffect(() => setForm(settings), [settings])` that
  // was here — it overwrites the local form state every time the store's
  // settings change (e.g. after saveSettings), which causes toggles like
  // showBootSplash to visually revert. The form is already kept in sync
  // by the explicit setForm calls in patch(), connectAgent(), clearApiKey(),
  // and the model-param handlers.

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

  useEffect(() => {
    if (paramsLoading) return;
    setStableParams(modelParams);
  }, [modelParams, paramsLoading]);

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

  useEffect(() => {
    if (leaf !== "diagnostics") return;
    void refreshDiagnostics();
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

  const actionLabel = (id: ChatActionId): string => {
    switch (id) {
      case "copy":
        return t("settings.chatActionCopy");
      case "edit":
        return t("settings.chatActionEdit");
      case "like":
        return t("settings.chatActionLike");
      case "dislike":
        return t("settings.chatActionDislike");
      case "share":
        return t("settings.chatActionShare");
      case "regenerate":
        return t("settings.chatActionRegenerate");
      case "readAloud":
        return t("settings.chatActionReadAloud");
    }
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
    const name = mcpDraft.name.trim();
    const url = (mcpDraft.url ?? "").trim();
    const token = (mcpDraft.token ?? "").trim();
    if (!name || !url) return;
    const id = mcpDraft.id || `mcp-${Date.now().toString(36)}`;
    const next: McpServerConfig = {
      ...mcpDraft,
      id,
      name,
      url,
      token: mcpDraft.type === "remote" && token ? token : undefined,
      command: undefined,
      args: undefined,
    };
    patch(
      "mcpServers",
      mcpServers.some((s) => s.id === id)
        ? mcpServers.map((s) => (s.id === id ? next : s))
        : [...mcpServers, next],
    );
    setMcpDraft(null);
  };

  const loadParamsForModel = async (nextModel: string) => {
    const cached = paramsCacheRef.current.get(nextModel);
    if (cached?.length) {
      setStableParams(cached);
      return;
    }
    if (nextModel === form.defaultModel && modelParams.length) {
      paramsCacheRef.current.set(nextModel, modelParams);
      setStableParams(modelParams);
      return;
    }
    const provider = settings.connectedProvider ?? form.defaultProvider;
    if (!provider) return;
    setParamsLoading(true);
    try {
      const res = await api.getModelParams(provider, nextModel);
      const fresh = res.modelParams ?? [];
      paramsCacheRef.current.set(nextModel, fresh);
      setStableParams(fresh);
      if (nextModel === form.defaultModel) {
        setModelParams(fresh);
      }
    } finally {
      setParamsLoading(false);
    }
  };

  const connectProvider = async (provider: AgentProvider) => {
    setConnectingId(provider);
    try {
      // Verify the agent is actually reachable before committing the connection.
      const probe = await api.probeAgent(provider);
      setProbes((prev) => ({ ...prev, [provider]: probe }));
      useAppStore.getState().setAgentAvailable(probe.ok);
      if (!probe.ok) {
        setModelsError(probe.message || t("settings.agentUnavailable"));
        return;
      }
      const same = form.connectedProvider === provider;
      const next: AppSettings = {
        ...form,
        defaultProvider: provider,
        connectedProvider: provider,
        defaultModel: same ? form.defaultModel : "",
        defaultModelParams: same ? form.defaultModelParams : {},
      };
      setForm(next);
      setModelsError(null);
      await saveSettings({
        defaultProvider: provider,
        connectedProvider: provider,
        defaultModel: next.defaultModel,
        defaultModelParams: next.defaultModelParams,
      });
      // Pull Fast/Effort for the new agent immediately (uses per-provider cache).
      const catalog = await useAppStore.getState().ensureModels(provider, { force: true });
      setModels(catalog?.models ?? []);
      setModelParams(catalog?.modelParams ?? []);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } finally {
      setConnectingId(null);
    }
  };

  const runProbe = async (provider: AgentProvider) => {
    setProbingId(provider);
    setProbes((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
    try {
      const result = await api.probeAgent(provider);
      setProbes((prev) => ({ ...prev, [provider]: result }));
      useAppStore.getState().setAgentAvailable(result.ok);
      if (result.ok && result.currentModel && form.defaultProvider === provider && !form.defaultModel) {
        const defaultModelParams = Object.fromEntries(
          (result.modelParams ?? [])
            .filter((p) => p.currentValue != null && p.currentValue !== "")
            .map((p) => [p.id, p.currentValue!]),
        );
        setForm((prev) => ({
          ...prev,
          defaultModel: result.currentModel!,
          defaultModelParams,
        }));
        setModelParams(result.modelParams ?? []);
        // Do not send defaultProvider — that would auto-connect the agent.
        await saveSettings({
          defaultModel: result.currentModel,
          defaultModelParams,
        });
      } else if (result.modelParams) {
        setModelParams(result.modelParams);
      }
    } catch (err) {
      setProbes((prev) => ({
        ...prev,
        [provider]: {
          ok: false,
          provider,
          command: adapterCommandFor(form, provider),
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setProbingId(null);
    }
  };

  const ensureModels = useAppStore((s) => s.ensureModels);
  const rememberModelsCatalog = useAppStore((s) => s.rememberModelsCatalog);

  useEffect(() => {
    if (section !== "agent" || leaf !== "model") return;
    const provider = settings.connectedProvider;
    if (!provider) {
      setModels([]);
      setModelParams([]);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    void ensureModels(provider, {
      force: adapterMeta(provider)?.cloudCatalog === true,
    })
      .then((catalog) => {
        if (cancelled || !catalog) return;
        setModels(catalog.models ?? []);
        setModelParams(catalog.modelParams ?? []);
        setForm((prev) => {
          const exposed = catalog.modelParams ?? [];
          const migrated = migrateModelParamValues(prev.defaultModelParams ?? {}, exposed);
          const nextParams =
            Object.keys(migrated).length > 0
              ? migrated
              : Object.fromEntries(
                  exposed
                    .filter((p) => p.currentValue != null && p.currentValue !== "")
                    .map((p) => [p.id, p.currentValue!]),
                );
          if (!prev.defaultModel && catalog.currentModel) {
            return {
              ...prev,
              defaultModel: catalog.currentModel,
              defaultModelParams: nextParams,
            };
          }
          return { ...prev, defaultModelParams: nextParams };
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setModels([]);
        setModelsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section, leaf, settings.connectedProvider, ensureModels]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Never send defaultProvider or theme from the form submit — the agent is
    // bound via "Connect", and the theme is toggled only from the toolbar, so
    // a stale form value must not flip the interface on a settings save.
    const { defaultProvider: _provider, theme: _theme, ...rest } = form;
    await saveSettings(rest);
    // The MCP probes fire server-side on save — fetch once so the dots turn
    // green right away instead of waiting for the next poll tick.
    api
      .mcpStatus()
      .then((s) => setMcpStatus(s))
      .catch(() => {
        // poll will retry
      });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const clearApiKey = async (
    key: "cursorApiKey" | "anthropicApiKey" | "openaiApiKey",
  ) => {
    const next = { ...form, [key]: "" };
    setForm(next);
    const { defaultProvider: _provider, theme: _theme, ...rest } = next;
    await saveSettings(rest);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const title =
    section === "interface"
      ? leaf === "colors"
        ? t("settings.colors")
        : leaf === "voice"
          ? t("settings.voiceTitle")
          : leaf === "chat"
            ? t("settings.chatTitle")
            : t("settings.appearance")
      : section === "agent"
        ? leaf === "connect"
          ? t("settings.agentConnectTitle")
          : leaf === "model"
            ? t("settings.agentModelTitle")
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
            : t("settings.sidebarCollapseHint")
      : section === "agent" && leaf === "mcp"
        ? t("settings.mcpHint")
        : section === "agent" && leaf === "advanced"
        ? t("settings.agentAdvancedDesc")
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
      <form className={styles.panel} onSubmit={(e) => void onSubmit(e)}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>{eyebrow}</p>
            <h1>{title}</h1>
            <p className={styles.lead}>{subtitle}</p>
          </div>
        </header>

        {section === "agent" && leaf === "connect" && (
          <>
            <SettingTable>
              {providers.map((item) => {
                const active = settings.connectedProvider === item.id;
                const probe = probes[item.id];
                const probing = probingId === item.id;
                const connecting = connectingId === item.id;
                return (
                  <SettingRow
                    key={item.id}
                    label={
                      <span className={styles.providerTitleRow}>
                        <span className={styles.providerTitle}>{item.title}</span>
                        {active && <span className={styles.providerBadge}>{t("common.connected")}</span>}
                      </span>
                    }
                    hint={
                      <>
                        {item.description}
                        {probe ? (
                          <span
                            className={`${styles.providerProbeInline} ${
                              probe.ok ? styles.probeOk : styles.probeFail
                            }`}
                          >
                            <strong>{probe.ok ? t("common.connected") : t("common.error")}</strong>
                            <span>{probe.message}</span>
                          </span>
                        ) : null}
                      </>
                    }
                  >
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      disabled={probing || connecting}
                      onClick={() => void runProbe(item.id)}
                    >
                      {probing ? t("common.checking") : t("common.check")}
                    </button>
                    <button
                      type="button"
                      className={active ? styles.connectBtnActive : styles.connectBtn}
                      disabled={connecting || (active && !connecting)}
                      onClick={() => void connectProvider(item.id)}
                    >
                      {connecting ? "…" : active ? t("common.connected") : t("common.connect")}
                    </button>
                  </SettingRow>
                );
              })}
            </SettingTable>
            {saved && leaf === "connect" && (
              <span className={styles.ok}>{t("settings.profileSaved")}</span>
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
            )}
          </>
        )}

        {section === "interface" && leaf === "chat" && (
          <>
            <ChatSettingsPreview
              actions={form.chatActions ?? []}
              chips={form.chatMetaChips ?? []}
              readAloud={Boolean(form.chatReadAloud)}
              voiceInput={Boolean(form.chatVoiceInput)}
              showTime={Boolean(form.chatShowMessageTime)}
              toolbarSize={form.chatToolbarSize ?? "default"}
              onToggleAction={(id) => {
                const cur = form.chatActions ?? [];
                patch(
                  "chatActions",
                  cur.includes(id) ? cur.filter((a) => a !== id) : [...cur, id],
                );
              }}
              onToggleChip={(id) =>
                patch("chatMetaChips", toggleInOrder(form.chatMetaChips ?? [], id, CHAT_CHIP_ORDER))
              }
            />
            <SettingTable>
              <SettingRow label={t("settings.chatActions")} hint={t("settings.chatActionsOrderHint")}>
                <div className={styles.actionList}>
                  {(form.chatActions ?? []).map((id, idx) => {
                    const count = (form.chatActions ?? []).length;
                    const move = (dir: -1 | 1) => {
                      const cur = [...(form.chatActions ?? [])];
                      const at = cur.indexOf(id);
                      const to = at + dir;
                      if (at < 0 || to < 0 || to >= cur.length) return;
                      const next = [...cur];
                      [next[at], next[to]] = [next[to], next[at]];
                      patch("chatActions", next);
                    };
                    return (
                      <div key={id} className={styles.actionListRow}>
                        <span className={styles.actionListLabel}>{actionLabel(id)}</span>
                        <button
                          type="button"
                          className={styles.actionListBtn}
                          disabled={idx === 0}
                          aria-label={`${t("common.moveUp")} ${actionLabel(id)}`}
                          title={t("common.moveUp")}
                          onClick={() => move(-1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className={styles.actionListBtn}
                          disabled={idx === count - 1}
                          aria-label={`${t("common.moveDown")} ${actionLabel(id)}`}
                          title={t("common.moveDown")}
                          onClick={() => move(1)}
                        >
                          ↓
                        </button>
                        <Toggle
                          checked
                          onChange={() =>
                            patch(
                              "chatActions",
                              (form.chatActions ?? []).filter((a) => a !== id),
                            )
                          }
                          label={actionLabel(id)}
                        />
                      </div>
                    );
                  })}
                  {CHAT_ACTION_ORDER.filter((id) => !(form.chatActions ?? []).includes(id)).length >
                  0 ? (
                    <div className={styles.actionAddRow}>
                      {CHAT_ACTION_ORDER.filter((id) => !(form.chatActions ?? []).includes(id)).map(
                        (id) => (
                          <button
                            key={id}
                            type="button"
                            className={styles.actionAddChip}
                            onClick={() =>
                              patch("chatActions", [...(form.chatActions ?? []), id])
                            }
                          >
                            + {actionLabel(id)}
                          </button>
                        ),
                      )}
                    </div>
                  ) : null}
                </div>
              </SettingRow>

              <SettingRow label={t("settings.chatMetaChips")} hint={t("settings.chatMetaChipsHint")}>
                <div className={styles.actionChips}>
                  {(
                    [
                      ["folder", t("settings.chatMetaChipFolder")],
                      ["thoughts", t("settings.chatMetaChipThoughts")],
                      ["mcp", t("settings.chatMetaChipMcp")],
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
                          patch(
                            "chatMetaChips",
                            toggleInOrder(form.chatMetaChips ?? [], id, CHAT_CHIP_ORDER),
                          )
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </SettingRow>

              <SettingRow label={t("settings.chatReadAloud")} hint={t("settings.chatReadAloudHint")}>
                <Toggle
                  checked={Boolean(form.chatReadAloud)}
                  onChange={(v) => patch("chatReadAloud", v)}
                  label={t("settings.chatReadAloud")}
                />
              </SettingRow>

              <SettingRow label={t("settings.chatTreeShowArchive")} hint={t("settings.chatTreeShowArchiveHint")}>
                <Toggle
                  checked={Boolean(form.chatTreeShowArchive)}
                  onChange={(v) => patch("chatTreeShowArchive", v)}
                  label={t("settings.chatTreeShowArchive")}
                />
              </SettingRow>

              <SettingRow label={t("settings.chatTreeDensity")} hint={t("settings.chatTreeDensityHint")}>
                <OptionPicker
                  variant="block"
                  placement="down"
                  menuTitle={t("settings.chatTreeDensity")}
                  value={form.chatTreeDensity ?? "cozy"}
                  onChange={(v) => patch("chatTreeDensity", v as AppSettings["chatTreeDensity"])}
                  options={[
                    { value: "cozy", label: t("settings.chatTreeDensityCozy") },
                    { value: "compact", label: t("settings.chatTreeDensityCompact") },
                  ]}
                />
              </SettingRow>

              <SettingRow label={t("settings.chatToolbarSize")} hint={t("settings.chatToolbarSizeHint")}>
                <OptionPicker
                  variant="block"
                  placement="down"
                  menuTitle={t("settings.chatToolbarSize")}
                  value={form.chatToolbarSize ?? "default"}
                  onChange={(v) => patch("chatToolbarSize", v as AppSettings["chatToolbarSize"])}
                  options={[
                    { value: "compact", label: t("settings.chatToolbarSizeCompact") },
                    { value: "default", label: t("settings.chatToolbarSizeDefault") },
                    { value: "roomy", label: t("settings.chatToolbarSizeRoomy") },
                  ]}
                />
              </SettingRow>

              <SettingRow label={t("settings.chatEnterToSend")} hint={t("settings.chatEnterToSendHint")}>
                <Toggle
                  checked={Boolean(form.chatEnterToSend)}
                  onChange={(v) => patch("chatEnterToSend", v)}
                  label={t("settings.chatEnterToSend")}
                />
              </SettingRow>

              <SettingRow label={t("settings.chatShowMessageTime")} hint={t("settings.chatShowMessageTimeHint")}>
                <Toggle
                  checked={Boolean(form.chatShowMessageTime)}
                  onChange={(v) => patch("chatShowMessageTime", v)}
                  label={t("settings.chatShowMessageTime")}
                />
              </SettingRow>

              <SettingRow label={t("settings.chatVoiceInput")} hint={t("settings.chatVoiceInputHint")}>
                <Toggle
                  checked={Boolean(form.chatVoiceInput)}
                  onChange={(v) => patch("chatVoiceInput", v)}
                  label={t("settings.chatVoiceInput")}
                />
              </SettingRow>
            </SettingTable>
          </>
        )}

        {section === "agent" && leaf === "model" && (
          !settings.connectedProvider ? (
            <p className={styles.hint}>{t("errors.agentNotConnected")}</p>
          ) : (
            <SettingTable>
              <SettingRow label={t("settings.modelSection")}>
                <ModelPicker
                  model={form.defaultModel}
                  models={models}
                  params={stableParams}
                  paramValues={form.defaultModelParams ?? {}}
                  paramsLoading={paramsLoading}
                  onChange={(value) => patch("defaultModel", value)}
                  onParamsChange={(next) =>
                    patch(
                      "defaultModelParams",
                      modelParams.length === 0
                        ? next
                        : migrateModelParamValues(next, modelParams),
                    )
                  }
                  onParamsOpen={(value) => loadParamsForModel(value)}
                  onOpen={() => {
                    const provider = settings.connectedProvider;
                    if (!provider) return;
                    void ensureModels(provider, {
                      force: adapterMeta(provider)?.cloudCatalog === true || modelParams.length === 0,
                    }).then((catalog) => {
                      if (!catalog) return;
                      setModels(catalog.models ?? []);
                      setModelParams(catalog.modelParams ?? []);
                      rememberModelsCatalog(catalog);
                    });
                  }}
                  placement="down"
                  variant="block"
                  loading={modelsLoading}
                />
              </SettingRow>
            </SettingTable>
          )
        )}

        {section === "agent" && leaf === "advanced" && (
          <>
            <SettingTable>
              <SettingRow label={t("settings.defaultFolder")}>
                <div className={styles.cwdPickRow}>
                  <button
                    type="button"
                    className={styles.cwdPath}
                    title={form.defaultCwd || undefined}
                    onClick={() => {
                      setFolderBrowseTarget("defaultCwd");
                      setFolderBrowseOpen(true);
                    }}
                  >
                    {form.defaultCwd || t("common.notSet")}
                  </button>
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
                hint={t("settings.exportDirHint", {
                  path: form.exportDir || exportDirDefault || "…",
                })}
              >
                <div className={styles.cwdPickRow}>
                  <span
                    className={styles.cwdPath}
                    title={form.exportDir || exportDirDefault || undefined}
                  >
                    {form.exportDir || exportDirDefault || t("common.notSet")}
                  </span>
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

              <SettingRow label={t("settings.permissionPolicy")}>
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

              <SettingRow label={t("settings.resumeAgentContext")} hint={t("settings.resumeAgentContextHint")}>
                <Toggle
                  checked={Boolean(form.resumeAgentContext)}
                  onChange={(v) => patch("resumeAgentContext", v)}
                  label={t("settings.resumeAgentContext")}
                />
              </SettingRow>

              <SettingRow label={t("settings.multitask")} hint={t("settings.multitaskHint")}>
                <Toggle
                  checked={Boolean(form.multitask)}
                  onChange={(v) => patch("multitask", v)}
                  label={t("settings.multitask")}
                />
              </SettingRow>
            </SettingTable>

            {form.permissionPolicy === "allowlist" && (
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
            )}

            <h2 className={styles.sectionHeading}>{t("settings.apiKeys")}</h2>
            <SettingTable>
              {(
                [
                  {
                    key: "cursorApiKey" as const,
                    label: `Cursor ${t("settings.apiKeys")}`,
                    env: "CURSOR_API_KEY",
                    placeholder: "",
                  },
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
                ] as const
              ).map((item) => {
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

            <details className={styles.cliDisclosure}>
              <summary>{t("settings.cliAndPermissions")}</summary>
              <div className={styles.cliDisclosureBody}>
                <p className={styles.fieldHint}>{t("settings.agentAdvancedDesc")}</p>
                {cliFormAdapters.map((a) => {
                  const command = String(
                    (form as unknown as Record<string, unknown>)[a.commandField] ?? "",
                  );
                  const args = (form as unknown as Record<string, unknown>)[a.argsField];
                  const apiKeyField = a.apiKeyField;
                  const apiKey = apiKeyField
                    ? String((form as unknown as Record<string, unknown>)[apiKeyField] ?? "")
                    : "";
                  return (
                    <label key={a.id}>
                      {a.label}
                      <div className={styles.row}>
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
                      </div>
                      {apiKeyField ? (
                        <input
                          value={apiKey}
                          onChange={(e) => patchAny(apiKeyField, e.target.value)}
                          placeholder={a.envApiKeyName ?? "API key"}
                        />
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </details>
          </>
        )}

        {section === "agent" && leaf === "mcp" && (
          <>
            <div className={styles.mcpApplyNote} role="note">
              {t("settings.mcpApplyHint")}
            </div>
            <SettingTable>
              {mcpServers.map((server) => (
                <SettingRow
                  key={server.id}
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
                        {server.type === "local" ? t("settings.mcpLocal") : t("settings.mcpRemote")}
                      </span>
                    </span>
                  }
                  hint={
                    <span className={styles.mcpRowDetail}>
                      {server.url}
                      {server.type === "remote" && server.token ? (
                        <span className={styles.mcpRowToken}> · {t("settings.mcpTokenSet")}</span>
                      ) : null}
                    </span>
                  }
                >
                  <label
                    className={styles.mcpToggle}
                    title={server.enabled ? t("settings.enabled") : t("settings.disabled")}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(server.enabled)}
                      onChange={(e) => updateMcp(server.id, { enabled: e.target.checked })}
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => setMcpDraft({ ...server })}
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
                  token: "",
                })
              }
            >
              + {t("settings.mcpAdd")}
            </button>

            {mcpDraft && (
              <div className={styles.mcpForm}>
                <input
                  className={styles.mcpInput}
                  placeholder={t("settings.mcpName")}
                  value={mcpDraft.name}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })}
                />
                <OptionPicker
                  variant="block"
                  placement="down"
                  menuTitle={t("settings.mcpType")}
                  value={mcpDraft.type}
                  onChange={(v) =>
                    setMcpDraft({
                      ...mcpDraft,
                      type: v === "remote" ? "remote" : "local",
                    })
                  }
                  options={[
                    { value: "local", label: t("settings.mcpLocal") },
                    { value: "remote", label: t("settings.mcpRemote") },
                  ]}
                />
                <input
                  className={styles.mcpInput}
                  placeholder={t("settings.mcpUrl")}
                  value={mcpDraft.url ?? ""}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })}
                />
                {mcpDraft.type === "remote" && (
                  <input
                    className={styles.mcpInput}
                    type="password"
                    placeholder={t("settings.mcpToken")}
                    value={mcpDraft.token ?? ""}
                    onChange={(e) => setMcpDraft({ ...mcpDraft, token: e.target.value })}
                  />
                )}
                <div className={styles.mcpFormActions}>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => setMcpDraft(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    disabled={!mcpDraft.name.trim() || !mcpDraft.url?.trim()}
                    onClick={saveMcp}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {section === "agent" && leaf === "diagnostics" && (
          <>
            <SettingTable>
              <SettingRow
                label={t("diagnostics.folder")}
                hint={t("diagnostics.folderHint", {
                  path: diagDirResolved || diagDirDefault || "…",
                })}
              >
                <div className={styles.cwdPickRow}>
                  <span
                    className={styles.cwdPath}
                    title={form.diagnosticsDir || diagDirDefault || undefined}
                  >
                    {form.diagnosticsDir || diagDirDefault || t("diagnostics.folderDefault")}
                  </span>
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
                  menuTitle={t("diagnostics.chat")}
                  placeholder={t("diagnostics.chatNone")}
                  emptyLabel={t("diagnostics.noChats")}
                  onChange={(value) => setDiagSessionId(value)}
                  options={[
                    { value: "", label: t("diagnostics.chatNone") },
                    ...sessions.map((s) => ({
                      value: s.id,
                      label: s.title || s.id.slice(0, 8),
                      hint:
                        s.id === activeSessionId
                          ? `${s.provider} · ${t("diagnostics.chatActive")}`
                          : s.provider,
                    })),
                  ]}
                />
              </SettingRow>
            </SettingTable>

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

            <h2 className={styles.sectionHeading}>{t("diagnostics.dumpsTitle")}</h2>
            <p className={styles.fieldHint}>{t("diagnostics.dumpsHint")}</p>
            {diagLoading && !diagItems.length ? (
              <p className={styles.hint}>{t("common.loading")}</p>
            ) : null}
            {!diagLoading && diagItems.length === 0 ? (
              <p className={styles.hint}>{t("diagnostics.empty")}</p>
            ) : null}
            <ul className={styles.diagList}>
              {diagItems.map((item) => (
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
            </ul>
          </>
        )}

        {section === "agent" && leaf === "remote" && (
          <>
            <SettingTable>
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
            </SettingTable>
            <div className={styles.remoteTipsBlock}>
              <h2 className={styles.sectionHeading}>{t("settings.remoteTipTitle")}</h2>
              <ul className={styles.remoteTips}>
                <li>{t("settings.remoteTipLocalhost")}</li>
                <li>{t("settings.remoteTipSameNetwork")}</li>
                <li>{t("settings.remoteTipFirewall")}</li>
                <li>{t("settings.remoteTipHttp")}</li>
                <li>{t("settings.remoteTipInstall")}</li>
              </ul>
            </div>
          </>
        )}

        {(section === "interface" ||
          (section === "agent" && leaf !== "connect" && leaf !== "remote")) && (
          <div className={styles.footerBar}>
            <button type="submit">{t("common.save")}</button>
            {saved && <span className={styles.ok}>{t("settings.saved")}</span>}
          </div>
        )}
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
