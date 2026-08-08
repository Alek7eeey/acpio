import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  migrateModelParamValues,
  modelDisplayName,
  providerCommand,
  usesCloudModelCatalog,
  type AgentProbeResult,
  type AgentProvider,
  type AppSettings,
  type ModelParamDto,
} from "@acprocess/shared";
import { api } from "../lib/api";
import { parseSettingsSearch } from "../lib/settingsNav";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { ModelPicker } from "../components/ModelPicker";
import styles from "./SettingsPage.module.css";

const PROVIDER_IDS = ["cursor", "opencode", "omp", "pi"] as const satisfies readonly AgentProvider[];

export function SettingsPage() {
  const t = useT();
  const providers = useMemo(
    () =>
      PROVIDER_IDS.map((id) => ({
        id,
        title: id === "cursor" ? "Cursor" : id === "opencode" ? "OpenCode" : id === "omp" ? "OMP" : "PI",
        description:
          id === "cursor"
            ? t("settings.cursorDesc")
            : id === "opencode"
              ? t("settings.opencodeDesc")
              : id === "omp"
                ? t("settings.ompDesc")
                : t("settings.piDesc"),
      })),
    [t],
  );
  const location = useLocation();
  const { section, leaf } = useMemo(
    () => parseSettingsSearch(location.search),
    [location.search],
  );
  const settings = useAppStore((s) => s.settings);
  const user = useAppStore((s) => s.user);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const updateProfile = useAppStore((s) => s.updateProfile);
  const changePassword = useAppStore((s) => s.changePassword);
  const [form, setForm] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);
  const [probes, setProbes] = useState<Partial<Record<AgentProvider, AgentProbeResult>>>({});
  const [probingId, setProbingId] = useState<AgentProvider | null>(null);
  const [connectingId, setConnectingId] = useState<AgentProvider | null>(null);
  const [models, setModels] = useState<Array<{ value: string; name: string }>>([]);
  const [modelParams, setModelParams] = useState<ModelParamDto[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [stableParams, setStableParams] = useState<ModelParamDto[]>([]);

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [passwordErr, setPasswordErr] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);

  useEffect(() => {
    setDisplayName(user?.displayName ?? user?.username ?? "");
  }, [user?.displayName, user?.username]);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  useEffect(() => {
    if (paramsLoading) return;
    setStableParams(modelParams);
  }, [modelParams, paramsLoading]);

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const loadParamsForModel = async (nextModel: string) => {
    setParamsLoading(true);
    try {
      const next = {
        ...form,
        defaultModel: nextModel,
        defaultModelParams: migrateModelParamValues(form.defaultModelParams ?? {}, modelParams),
      };
      setForm(next);
      await saveSettings({
        defaultModel: next.defaultModel,
        defaultModelParams: next.defaultModelParams,
      });
      const catalog = await ensureModels(
        user?.connectedProvider ?? form.defaultProvider,
        { force: true },
      );
      const fresh = catalog?.modelParams ?? [];
      setModels(catalog?.models ?? models);
      setModelParams(fresh);
      setStableParams(fresh);
      if (catalog) rememberModelsCatalog(catalog);
      setForm((prev) => ({
        ...prev,
        defaultModel: nextModel,
        defaultModelParams: migrateModelParamValues(prev.defaultModelParams ?? {}, fresh),
      }));
    } finally {
      setParamsLoading(false);
    }
  };

  const connectProvider = async (provider: AgentProvider) => {
    setConnectingId(provider);
    try {
      const next: AppSettings = {
        ...form,
        defaultProvider: provider,
        defaultModel: form.defaultProvider === provider ? form.defaultModel : "",
        defaultModelParams: form.defaultProvider === provider ? form.defaultModelParams : {},
      };
      setForm(next);
      setModelsError(null);
      await saveSettings(next);
      // Pull Fast/Усилие for the new agent immediately (uses per-provider cache).
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
    const provider = user?.connectedProvider;
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
    void ensureModels(provider, { force: true })
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
  }, [section, leaf, user?.connectedProvider, ensureModels]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (section === "account") return;
    // Never send defaultProvider from the form submit — only «Подключить» binds an agent.
    const { defaultProvider: _provider, ...rest } = form;
    await saveSettings(rest);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const saveProfile = async () => {
    setProfileErr(null);
    setProfileMsg(null);
    setProfileBusy(true);
    try {
      await updateProfile(displayName);
      setProfileMsg(t("settings.profileSaved"));
      window.setTimeout(() => setProfileMsg(null), 1600);
    } catch (err) {
      setProfileErr(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileBusy(false);
    }
  };

  const savePassword = async () => {
    setPasswordErr(null);
    setPasswordMsg(null);
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordErr(t("settings.fillAllFields"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordErr(t("auth.passwordsMismatch"));
      return;
    }
    setPasswordBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMsg(t("settings.passwordUpdated"));
      window.setTimeout(() => setPasswordMsg(null), 1600);
    } catch (err) {
      setPasswordErr(err instanceof Error ? err.message : String(err));
    } finally {
      setPasswordBusy(false);
    }
  };

  const clearApiKey = async (
    key: "cursorApiKey" | "opencodeApiKey" | "anthropicApiKey" | "openaiApiKey",
  ) => {
    const next = { ...form, [key]: "" };
    setForm(next);
    const { defaultProvider: _provider, ...rest } = next;
    await saveSettings(rest);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const title =
    section === "agent"
      ? leaf === "connect"
        ? t("settings.agentConnectTitle")
        : leaf === "model"
          ? t("settings.agentModelTitle")
          : t("settings.agentAdvancedTitle")
      : t("settings.profileTitle");

  const subtitle =
    section === "agent"
      ? leaf === "advanced"
        ? t("settings.agentAdvancedDesc")
        : t("settings.agentConnectDesc")
      : t("settings.profileDesc");

  const eyebrow = section === "agent" ? t("settings.agents") : t("settings.general");

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
              // Per-user connection (admin column), not the shared global defaultProvider.
              const active = user?.connectedProvider === item.id;
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
                        {probe.currentModel && (
                          <div>Model: {modelDisplayName(probe.currentModel)}</div>
                        )}
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

        {section === "agent" && leaf === "model" && (
          <section className={styles.card}>
            {!user?.connectedProvider ? (
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
                  const provider = user.connectedProvider;
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
            {modelParams.length === 0 && !modelsLoading && user.connectedProvider === "cursor" && (
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
                  <input
                    value={form.defaultCwd}
                    readOnly
                    placeholder={t("common.notSet")}
                    title={form.defaultCwd || undefined}
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      void api
                        .pickDirectory(form.defaultCwd || undefined)
                        .then((res) => {
                          if (res.path) patch("defaultCwd", res.path);
                        })
                        .catch(() => {
                          /* dialog cancel / failure — ignore toast here */
                        });
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
                <select
                  value={form.permissionPolicy}
                  onChange={(e) =>
                    patch("permissionPolicy", e.target.value as AppSettings["permissionPolicy"])
                  }
                >
                  <option value="always">{t("settings.permissionAlways")}</option>
                  <option value="prompt">{t("settings.permissionPrompt")}</option>
                  <option value="allowlist">{t("settings.permissionAllowlist")}</option>
                </select>
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
                    key: "opencodeApiKey" as const,
                    label: `OpenCode ${t("settings.apiKeys")}`,
                    env: "OPENCODE_API_KEY",
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
                  OpenCode
                  <div className={styles.row}>
                    <input
                      value={form.opencodeCommand}
                      onChange={(e) => patch("opencodeCommand", e.target.value)}
                      placeholder="opencode"
                    />
                    <input
                      value={(form.opencodeArgs ?? []).join(" ")}
                      onChange={(e) =>
                        patch(
                          "opencodeArgs",
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
                <label>
                  PI
                  <div className={styles.row}>
                    <input
                      value={form.piCommand ?? "pi-acp"}
                      onChange={(e) => patch("piCommand", e.target.value)}
                      placeholder="pi-acp"
                    />
                    <input
                      value={(form.piArgs ?? []).join(" ")}
                      onChange={(e) =>
                        patch(
                          "piArgs",
                          e.target.value.split(/\s+/).filter(Boolean),
                        )
                      }
                      placeholder="(пусто) или -y pi-acp для npx"
                    />
                  </div>
                </label>
              </div>
            </details>
          </section>
        )}

        {section === "account" && (
          <>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>{t("settings.displayName")}</h2>
              <p className={styles.cardHint}>{t("settings.profileDesc")}</p>
              <label>
                {t("auth.username")}
                <input value={user?.username ?? ""} disabled readOnly />
              </label>
              <label>
                {t("settings.displayName")}
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t("settings.displayNamePlaceholder")}
                  maxLength={80}
                />
              </label>
              {profileErr && <div className={styles.accountErr}>{profileErr}</div>}
              {profileMsg && <div className={styles.accountOk}>{profileMsg}</div>}
              <div className={styles.footerBar}>
                <button
                  type="button"
                  disabled={profileBusy}
                  onClick={() => void saveProfile()}
                >
                  {profileBusy ? "…" : t("common.save")}
                </button>
              </div>
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>{t("auth.password")}</h2>
              <p className={styles.cardHint}>{t("settings.changePassword")}</p>
              <label>
                {t("settings.currentPassword")}
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder={t("settings.currentPasswordPlaceholder")}
                />
              </label>
              <label>
                {t("settings.newPassword")}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t("settings.newPasswordPlaceholder")}
                />
              </label>
              <label>
                {t("settings.confirmNewPassword")}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t("settings.confirmNewPasswordPlaceholder")}
                />
              </label>
              {passwordErr && <div className={styles.accountErr}>{passwordErr}</div>}
              {passwordMsg && <div className={styles.accountOk}>{passwordMsg}</div>}
              <div className={styles.footerBar}>
                <button
                  type="button"
                  disabled={passwordBusy}
                  onClick={() => void savePassword()}
                >
                  {passwordBusy ? "…" : t("settings.changePassword")}
                </button>
              </div>
            </section>
          </>
        )}

        {section === "agent" && leaf !== "connect" && (
          <div className={styles.footerBar}>
            <button type="submit">{t("common.save")}</button>
            {saved && <span className={styles.ok}>{t("settings.profileSaved")}</span>}
          </div>
        )}
      </form>
    </div>
  );
}
