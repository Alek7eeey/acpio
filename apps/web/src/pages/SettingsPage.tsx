import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  migrateModelParamValues,
  providerCommand,
  usesCloudModelCatalog,
  type AgentProbeResult,
  type AgentProvider,
  type AppSettings,
  type DiagnosticsDumpMeta,
  type McpServerConfig,
  type ModelParamDto,
} from "@acprocess/shared";
import { api } from "../lib/api";
import { parseSettingsSearch } from "../lib/settingsNav";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { ModelPicker } from "../components/ModelPicker";
import { OptionPicker } from "../components/OptionPicker";
import { ServerFolderBrowseDialog } from "../components/ServerFolderBrowseDialog";
import { getDiagnosticsDump, submitDiagnosticsDump } from "../lib/diagnostics";
import { startReadAloud, stopReadAloud } from "../lib/tts";
import { DARK_SCHEMES, LIGHT_SCHEMES, SYSTEM_SWATCH } from "../lib/themeSchemes";
import styles from "./SettingsPage.module.css";

const PROVIDER_IDS = ["cursor", "omp"] as const satisfies readonly AgentProvider[];

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
  const providers = useMemo(
    () =>
      PROVIDER_IDS.map((id) => ({
        id,
        title: id === "cursor" ? "Cursor" : "OMP",
        description: id === "cursor" ? t("settings.cursorDesc") : t("settings.ompDesc"),
      })),
    [t],
  );
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
  const [folderBrowseTarget, setFolderBrowseTarget] = useState<"defaultCwd" | "diagnosticsDir">(
    "defaultCwd",
  );
  const [copied, setCopied] = useState(false);
  const [connectingId, setConnectingId] = useState<AgentProvider | null>(null);
  const [mcpDraft, setMcpDraft] = useState<McpServerConfig | null>(null);
  const [mcpStatus, setMcpStatus] = useState<Record<string, boolean>>({});
  const [ttsHasNatural, setTtsHasNatural] = useState(false);
  const [ttsEngine, setTtsEngine] = useState<"unknown" | "piper" | "browser">("unknown");
  const [ttsVoicesByGender, setTtsVoicesByGender] = useState<{
    female: { ru: string | null; en: string | null };
    male: { ru: string | null; en: string | null };
  } | null>(null);
  const [ttsTestEngine, setTtsTestEngine] = useState<"idle" | "piper" | "browser">("idle");
  const [models, setModels] = useState<Array<{ value: string; name: string }>>([]);
  const [modelParams, setModelParams] = useState<ModelParamDto[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [stableParams, setStableParams] = useState<ModelParamDto[]>([]);
  const [diagDirDefault, setDiagDirDefault] = useState("");
  const [diagDirResolved, setDiagDirResolved] = useState("");
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

  useEffect(() => {
    if (section !== "interface" || leaf !== "voice") return;
    let cancelled = false;
    fetch("/api/tts/ping")
      .then((r) => r.json())
      .then((d: { available?: boolean; voicesByGender?: unknown }) => {
        if (cancelled) return;
        setTtsEngine(d.available ? "piper" : "browser");
        if (d.voicesByGender) {
          setTtsVoicesByGender(
            d.voicesByGender as {
              female: { ru: string | null; en: string | null };
              male: { ru: string | null; en: string | null };
            },
          );
        }
      })
      .catch(() => {
        if (!cancelled) setTtsEngine("browser");
      });
    return () => {
      cancelled = true;
    };
  }, [section, leaf]);

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const mcpServers = form.mcpServers ?? [];
  const mcpKey = mcpServers
    .map((s) => `${s.id}:${s.enabled ? 1 : 0}:${s.url ?? ""}`)
    .join("|");

  // Live probe status for enabled MCP servers (dot next to each row).
  useEffect(() => {
    let alive = true;
    void api
      .mcpStatus()
      .then((s) => {
        if (alive) setMcpStatus(s);
      })
      .catch(() => {
        // server offline — keep previous dots
      });
    return () => {
      alive = false;
    };
  }, [mcpKey]);

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
          command: providerCommand(form, provider),
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
      force: usesCloudModelCatalog(provider),
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
          <section className={styles.providerList}>
            <p className={styles.hint}>{t("settings.agentConnectDesc")}</p>
            {providers.map((item) => {
              const active = settings.connectedProvider === item.id;
              const probe = probes[item.id];
              const probing = probingId === item.id;
              const connecting = connectingId === item.id;
              return (
                <div
                  key={item.id}
                  className={`${styles.providerRow} ${active ? styles.providerRowActive : ""}`}
                >
                  <div className={styles.providerMeta}>
                    <div className={styles.providerTitleRow}>
                      <span className={styles.providerTitle}>{item.title}</span>
                      {active && <span className={styles.providerBadge}>{t("common.connected")}</span>}
                    </div>
                    <p className={styles.providerDesc}>{item.description}</p>
                    {probe && (
                      <div
                        className={`${styles.providerProbe} ${
                          probe.ok ? styles.probeOk : styles.probeFail
                        }`}
                      >
                        <strong>{probe.ok ? t("common.connected") : t("common.error")}</strong>
                        <div>{probe.message}</div>
                      </div>
                    )}
                  </div>
                  <div className={styles.providerActions}>
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
                  </div>
                </div>
              );
            })}
            {saved && leaf === "connect" && (
              <span className={styles.ok}>{t("settings.profileSaved")}</span>
            )}
          </section>
        )}

        {section === "interface" && leaf === "appearance" && (
          <section className={styles.card}>
            <div className={styles.sectionBlock}>
              <label>
                {t("settings.sidebarCollapse")}
                <OptionPicker
                  variant="block"
                  placement="down"
                  menuTitle={t("settings.sidebarCollapse")}
                  value={form.sidebarCollapse}
                  onChange={(v) =>
                    patch("sidebarCollapse", v as AppSettings["sidebarCollapse"])
                  }
                  options={[
                    { value: "full", label: t("settings.sidebarCollapseFull") },
                    { value: "rail", label: t("settings.sidebarCollapseRail") },
                  ]}
                />
              </label>
              <p className={styles.fieldHint}>{t("settings.sidebarCollapseHint")}</p>
            </div>

            <div className={styles.sectionBlock}>
              <label>
                {t("settings.fontFamily")}
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
              </label>
              <p className={styles.fieldHint}>{t("settings.fontFamilyHint")}</p>

              <label>
                {t("settings.fontSize")}
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
              </label>
              <p className={styles.fieldHint}>{t("settings.fontSizeHint")}</p>
            </div>

            <div className={styles.sectionBlock}>
              <label className={`${styles.switchCard} ${form.showBootSplash ? styles.switchCardOn : ""}`}>
                <input
                  type="checkbox"
                  className={styles.switchInput}
                  checked={Boolean(form.showBootSplash)}
                  onChange={(e) => patch("showBootSplash", e.target.checked)}
                />
                <span className={styles.switchIcon} aria-hidden>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className={styles.switchBody}>
                  <strong>{t("settings.showBootSplash")}</strong>
                  <span>{t("settings.showBootSplashHint")}</span>
                </span>
                <span className={styles.switchSwitch} aria-hidden>
                  <span />
                </span>
              </label>
            </div>
          </section>
        )}

        {section === "interface" && leaf === "colors" && (
          <section className={styles.card}>
            <div className={styles.sectionBlock}>
              <h2 className={styles.sectionHeading}>{t("settings.lightScheme")}</h2>
              <p className={styles.fieldHint}>{t("settings.lightSchemeHint")}</p>
              <div className={styles.schemeGrid}>
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
            </div>

            <div className={styles.sectionBlock}>
              <h2 className={styles.sectionHeading}>{t("settings.darkScheme")}</h2>
              <p className={styles.fieldHint}>{t("settings.darkSchemeHint")}</p>
              <div className={styles.schemeGrid}>
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
            </div>
          </section>
        )}

        {section === "interface" && leaf === "voice" && (
          <section className={styles.card}>
            <div className={styles.sectionBlock}>
              <label>
                {t("settings.ttsVoiceGender")}
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
              </label>
              <p className={styles.fieldHint}>{t("settings.ttsVoiceGenderHint")}</p>

              <div className={styles.ttsTestRow}>
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
                        onEnd: () => setTtsTestEngine("idle"),
                        onEngine: (engine) => setTtsTestEngine(engine),
                      },
                    );
                  }}
                >
                  {t("settings.ttsTest")}
                </button>
                {ttsTestEngine !== "idle" && (
                  <span className={styles.ttsTestStatus}>
                    {ttsTestEngine === "piper"
                      ? t("settings.ttsTestPiper")
                      : t("settings.ttsTestBrowser")}
                  </span>
                )}
              </div>

              {ttsEngine !== "unknown" && (
                <p className={styles.fieldHint}>
                  {ttsEngine === "piper" ? t("settings.ttsEnginePiper") : t("settings.ttsEngineBrowser")}
                </p>
              )}

              {ttsVoicesByGender && (
                <div className={styles.ttsVoicesGrid}>
                  {(form.ttsVoiceGender === "" || form.ttsVoiceGender === "female") && (
                    <p className={styles.fieldHint}>
                      {t("settings.ttsGenderFemale")}:{" "}
                      {t("settings.ttsResolvedVoices", {
                        ru: ttsVoicesByGender.female.ru ?? "—",
                        en: ttsVoicesByGender.female.en ?? "—",
                      })}
                    </p>
                  )}
                  {(form.ttsVoiceGender === "" || form.ttsVoiceGender === "male") && (
                    <p className={styles.fieldHint}>
                      {t("settings.ttsGenderMale")}:{" "}
                      {t("settings.ttsResolvedVoices", {
                        ru: ttsVoicesByGender.male.ru ?? "—",
                        en: ttsVoicesByGender.male.en ?? "—",
                      })}
                    </p>
                  )}
                </div>
              )}

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
            </div>
          </section>
        )}

        {section === "agent" && leaf === "model" && (
          <section className={styles.card}>
            {!settings.connectedProvider ? (
              <p className={styles.hint}>{t("errors.agentNotConnected")}</p>
            ) : (
              <>
            <div className={styles.modelField}>
              <span className={styles.modelLabel}>{t("settings.modelSection")}</span>
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
                    force: usesCloudModelCatalog(provider) || modelParams.length === 0,
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
              {modelsError && !modelsLoading && (
                <p className={styles.hint}>{modelsError}</p>
              )}
            </div>
            {modelParams.length === 0 && !modelsLoading && settings.connectedProvider === "cursor" && (
              <p className={styles.hint}>{t("common.check")}</p>
            )}
              </>
            )}
          </section>
        )}

        {section === "agent" && leaf === "advanced" && (
          <section className={styles.card}>
            <div className={styles.sectionBlock}>
              <label>
                {t("settings.defaultFolder")}
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
              </label>
              <p className={styles.fieldHint}>{t("settings.defaultFolder")}</p>
              <label>
                {t("settings.permissionPolicy")}
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
              </label>
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
            </div>

            <div className={`${styles.sectionBlock} ${styles.switchSection}`}>
              <label className={`${styles.switchCard} ${form.multitask ? styles.switchCardOn : ""}`}>
                <input
                  type="checkbox"
                  className={styles.switchInput}
                  checked={Boolean(form.multitask)}
                  onChange={(e) => patch("multitask", e.target.checked)}
                />
                <span className={styles.switchBody}>
                  <strong>{t("settings.multitask")}</strong>
                  <span>{t("settings.multitaskHint")}</span>
                </span>
                <span className={styles.switchSwitch} aria-hidden>
                  <span />
                </span>
              </label>
            </div>

            <div className={styles.sectionBlock}>
              <h2 className={styles.sectionHeading}>{t("settings.apiKeys")}</h2>
              <p className={styles.fieldHint}>{t("settings.cliAndPermissions")}</p>
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
                  <div key={item.key} className={styles.secretField}>
                    <span className={styles.modelLabel}>{item.label}</span>
                    <span className={styles.fieldHint}>{item.env}</span>
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
                  </div>
                );
              })}
            </div>

            <details className={styles.cliDisclosure}>
              <summary>{t("settings.cliAndPermissions")}</summary>
              <div className={styles.cliDisclosureBody}>
                <p className={styles.fieldHint}>{t("settings.agentAdvancedDesc")}</p>
                <label>
                  Cursor
                  <div className={styles.row}>
                    <input
                      value={form.cursorCommand}
                      onChange={(e) => patch("cursorCommand", e.target.value)}
                      placeholder="agent"
                    />
                    <input
                      value={(form.cursorArgs ?? []).join(" ")}
                      onChange={(e) =>
                        patch(
                          "cursorArgs",
                          e.target.value.split(/\s+/).filter(Boolean),
                        )
                      }
                      placeholder="acp"
                    />
                  </div>
                </label>
                <label>
                  OMP
                  <div className={styles.row}>
                    <input
                      value={form.ompCommand ?? "omp"}
                      onChange={(e) => patch("ompCommand", e.target.value)}
                      placeholder="omp"
                    />
                    <input
                      value={(form.ompArgs ?? ["acp"]).join(" ")}
                      onChange={(e) =>
                        patch(
                          "ompArgs",
                          e.target.value.split(/\s+/).filter(Boolean),
                        )
                      }
                      placeholder="acp"
                    />
                  </div>
                </label>
              </div>
            </details>
          </section>
        )}

        {section === "agent" && leaf === "mcp" && (
          <section className={styles.card}>
            <div className={styles.sectionBlock}>
              <p className={styles.fieldHint}>{t("settings.mcpHint")}</p>

              {mcpServers.map((server) => (
                <div key={server.id} className={styles.mcpRow}>
                  <div className={styles.mcpRowMeta}>
                    {server.enabled ? (
                      <span
                        className={`${styles.mcpStatusDot} ${
                          mcpStatus[server.id] ? styles.mcpStatusDotOk : styles.mcpStatusDotBad
                        }`}
                        title={
                          mcpStatus[server.id]
                            ? t("common.connected")
                            : t("common.notConnected")
                        }
                        aria-hidden
                      />
                    ) : null}
                    <strong>{server.name}</strong>
                    <span className={styles.mcpRowType}>
                      {server.type === "local" ? t("settings.mcpLocal") : t("settings.mcpRemote")}
                    </span>
                    <span className={styles.mcpRowDetail}>
                      {server.url}
                      {server.type === "remote" && server.token ? (
                        <span className={styles.mcpRowToken}> · {t("settings.mcpTokenSet")}</span>
                      ) : null}
                    </span>
                  </div>
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
                </div>
              ))}

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
            </div>
          </section>
        )}

        {section === "agent" && leaf === "diagnostics" && (
          <section className={styles.card}>
            <div className={styles.sectionBlock}>
              <label>
                {t("diagnostics.folder")}
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
              </label>
              <p className={styles.fieldHint}>
                {t("diagnostics.folderHint", {
                  path: diagDirResolved || diagDirDefault || "…",
                })}
              </p>
            </div>

            <div className={styles.sectionBlock}>
              <div className={styles.modelField}>
                <span className={styles.modelLabel}>{t("diagnostics.chat")}</span>
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
              </div>
              <p className={styles.fieldHint}>
                {sessions.length === 0 ? t("diagnostics.noChats") : t("diagnostics.chatHint")}
              </p>
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
              </div>
              {diagMessage ? <p className={styles.hint}>{diagMessage}</p> : null}
            </div>

            <div className={styles.sectionBlock}>
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
            </div>
          </section>
        )}

        {section === "agent" && leaf === "remote" && (
          <section className={`${styles.card} ${styles.remoteCard}`}>
            <div className={styles.remoteStep}>
              <span className={styles.remoteStepNum} aria-hidden>
                1
              </span>
              <div className={styles.remoteStepBody}>
                <h2 className={styles.sectionHeading}>{t("settings.remoteStep1Title")}</h2>
                <p className={styles.fieldHint}>{t("settings.remoteStep1Body")}</p>
              </div>
            </div>
            <div className={styles.remoteStep}>
              <span className={styles.remoteStepNum} aria-hidden>
                2
              </span>
              <div className={styles.remoteStepBody}>
                <h2 className={styles.sectionHeading}>{t("settings.remoteStep2Title")}</h2>
                <p className={styles.fieldHint}>{t("settings.remoteStep2Body")}</p>
                <p className={styles.fieldHint}>{t("settings.remoteStep2HowIp")}</p>
              </div>
            </div>
            <div className={styles.remoteStep}>
              <span className={styles.remoteStepNum} aria-hidden>
                3
              </span>
              <div className={styles.remoteStepBody}>
                <h2 className={styles.sectionHeading}>{t("settings.remoteStep3Title")}</h2>
                <p className={styles.fieldHint}>{t("settings.remoteStep3Body")}</p>
                <label className={styles.remoteUrlLabel}>
                  {t("settings.remoteCurrentUrl")}
                  <div className={styles.remoteUrlRow}>
                    <input value={pageUrl} readOnly title={pageUrl || undefined} />
                    <button type="button" className={styles.secondaryBtn} onClick={() => void copyUrl()}>
                      {copied ? t("settings.remoteCopied") : t("settings.remoteCopy")}
                    </button>
                  </div>
                </label>
              </div>
            </div>
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
          </section>
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
            : form.defaultCwd || undefined
        }
        onClose={() => setFolderBrowseOpen(false)}
        onSelect={(path) => patch(folderBrowseTarget, path)}
      />
    </div>
  );
}
