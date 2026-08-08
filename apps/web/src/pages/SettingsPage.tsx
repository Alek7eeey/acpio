import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  migrateModelParamValues,
  modelDisplayName,
  providerCommand,
  type AgentProbeResult,
  type AgentProvider,
  type AppSettings,
  type ModelParamDto,
} from "@acprocess/shared";
import { api } from "../lib/api";
import { parseSettingsSearch } from "../lib/settingsNav";
import { useAppStore } from "../lib/store";
import { ModelPicker } from "../components/ModelPicker";
import styles from "./SettingsPage.module.css";

const PROVIDERS: Array<{
  id: AgentProvider;
  title: string;
  description: string;
}> = [
  {
    id: "cursor",
    title: "Cursor",
    description: "Cursor Agent CLI (`agent acp`)",
  },
  {
    id: "opencode",
    title: "OpenCode",
    description: "Локальный OpenCode CLI через ACP",
  },
  {
    id: "omp",
    title: "OMP",
    description: "Oh My Pi через ACP (`omp acp`)",
  },
  {
    id: "pi",
    title: "PI",
    description: "Pi coding agent через ACP (`pi-acp`)",
  },
];

export function SettingsPage() {
  const location = useLocation();
  const { section, leaf } = useMemo(
    () => parseSettingsSearch(location.search),
    [location.search],
  );
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const user = useAppStore((s) => s.user);
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
      await saveSettings(next);
      const catalog = await ensureModels(form.defaultProvider, { force: true });
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
        const next = {
          ...form,
          defaultModel: result.currentModel,
          defaultModelParams: Object.fromEntries(
            (result.modelParams ?? [])
              .filter((p) => p.currentValue != null && p.currentValue !== "")
              .map((p) => [p.id, p.currentValue!]),
          ),
        };
        setForm(next);
        setModelParams(result.modelParams ?? []);
        await saveSettings(next);
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
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    void ensureModels(form.defaultProvider, { force: true })
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
  }, [section, leaf, form.defaultProvider, ensureModels]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (section === "account") return;
    await saveSettings(form);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const saveProfile = async () => {
    setProfileErr(null);
    setProfileMsg(null);
    setProfileBusy(true);
    try {
      await updateProfile(displayName);
      setProfileMsg("Имя сохранено");
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
      setPasswordErr("Заполните все поля");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordErr("Пароли не совпадают");
      return;
    }
    setPasswordBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMsg("Пароль обновлён");
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
    await saveSettings(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const title =
    section === "agent"
      ? leaf === "connect"
        ? "Подключение агента"
        : leaf === "model"
          ? "Модель"
          : "Дополнительно"
      : "Профиль";

  const subtitle =
    section === "agent"
      ? leaf === "advanced"
        ? "Папка по умолчанию, API-ключи и запуск CLI"
        : "Выберите агент и проверьте ACP"
      : "Имя и пароль аккаунта";

  const eyebrow = section === "agent" ? "Агенты" : "Общее";

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
            <p className={styles.hint}>
              Используются локальные настройки CLI. Ключи не нужны, если агент уже авторизован.
            </p>
            {PROVIDERS.map((item) => {
              const active = form.defaultProvider === item.id;
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
                      {active && <span className={styles.providerBadge}>Активен</span>}
                    </div>
                    <p className={styles.providerDesc}>{item.description}</p>
                    {probe && (
                      <div
                        className={`${styles.providerProbe} ${
                          probe.ok ? styles.probeOk : styles.probeFail
                        }`}
                      >
                        <strong>{probe.ok ? "Подключено" : "Ошибка"}</strong>
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
                      {probing ? "Проверяю…" : "Проверить"}
                    </button>
                    <button
                      type="button"
                      className={active ? styles.connectBtnActive : styles.connectBtn}
                      disabled={connecting || (active && !connecting)}
                      onClick={() => void connectProvider(item.id)}
                    >
                      {connecting ? "…" : active ? "Подключён" : "Подключить"}
                    </button>
                  </div>
                </div>
              );
            })}
            {saved && leaf === "connect" && (
              <span className={styles.ok}>Сохранено</span>
            )}
          </section>
        )}

        {section === "agent" && leaf === "model" && (
          <section className={styles.card}>
            <div className={styles.modelField}>
              <span className={styles.modelLabel}>Модель по умолчанию</span>
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
                  void ensureModels(form.defaultProvider, {
                    force: modelParams.length === 0,
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
                <p className={styles.hint}>Не удалось обновить список: {modelsError}</p>
              )}
            </div>
            {modelParams.length === 0 && !modelsLoading && form.defaultProvider === "cursor" && (
              <p className={styles.hint}>
                Если нет выбора Fast / Effort — нажми «Проверить» у Cursor на вкладке Подключение
                (нужен рестарт ACP-сессии).
              </p>
            )}
          </section>
        )}

        {section === "agent" && leaf === "advanced" && (
          <section className={styles.card}>
            <div className={styles.sectionBlock}>
              <label>
                Папка по умолчанию для новых чатов
                <div className={styles.cwdPickRow}>
                  <input
                    value={form.defaultCwd}
                    readOnly
                    placeholder="Не задана"
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
                    Выбрать…
                  </button>
                  {form.defaultCwd ? (
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => patch("defaultCwd", "")}
                    >
                      Сбросить
                    </button>
                  ) : null}
                </div>
              </label>
              <p className={styles.fieldHint}>
                Подставляется в диалоге создания чата. Рабочая папка чата выбирается в Проводнике
                при создании.
              </p>
              <label>
                Политика разрешений
                <select
                  value={form.permissionPolicy}
                  onChange={(e) =>
                    patch("permissionPolicy", e.target.value as AppSettings["permissionPolicy"])
                  }
                >
                  <option value="always">Всегда разрешать</option>
                  <option value="prompt">Спрашивать</option>
                  <option value="allowlist">Allowlist</option>
                </select>
              </label>
            </div>

            <div className={styles.sectionBlock}>
              <h2 className={styles.sectionHeading}>API-ключи</h2>
              <p className={styles.fieldHint}>
                Необязательны, если CLI уже авторизован локально (`agent login` / `opencode auth
                login`). Нужны для headless/сервера без интерактивного логина.
              </p>
              {(
                [
                  {
                    key: "cursorApiKey" as const,
                    label: "API-ключ Cursor",
                    env: "CURSOR_API_KEY",
                    placeholder: "",
                  },
                  {
                    key: "opencodeApiKey" as const,
                    label: "API-ключ OpenCode",
                    env: "OPENCODE_API_KEY",
                    placeholder: "",
                  },
                  {
                    key: "anthropicApiKey" as const,
                    label: "API-ключ Anthropic",
                    env: "ANTHROPIC_API_KEY",
                    placeholder: "sk-ant-...",
                  },
                  {
                    key: "openaiApiKey" as const,
                    label: "API-ключ OpenAI",
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
                        title="Удалить ключ из настроек"
                        onClick={() => void clearApiKey(item.key)}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <details className={styles.cliDisclosure}>
              <summary>Запуск CLI — дополнительно</summary>
              <div className={styles.cliDisclosureBody}>
                <p className={styles.fieldHint}>
                  Команда и аргументы для локального ACP-бинарника. Обычно хватает значений по
                  умолчанию (`agent acp`, `opencode acp`, `omp acp`, `pi-acp`). Меняйте только если CLI
                  установлен под другим именем или путём.
                </p>
                <label>
                  Cursor — команда / аргументы
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
                  OpenCode — команда / аргументы
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
                  OMP — команда / аргументы
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
                  PI — команда / аргументы
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
              <h2 className={styles.cardTitle}>Имя</h2>
              <p className={styles.cardHint}>Отображается в аккаунте</p>
              <label>
                Логин
                <input value={user?.username ?? ""} disabled readOnly />
              </label>
              <label>
                Имя
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Как к вам обращаться"
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
                  {profileBusy ? "…" : "Сохранить"}
                </button>
              </div>
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Пароль</h2>
              <p className={styles.cardHint}>Смена пароля аккаунта</p>
              <label>
                Текущий пароль
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Введите текущий пароль"
                />
              </label>
              <label>
                Новый пароль
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Введите новый пароль"
                />
              </label>
              <label>
                Подтвердите пароль
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Повторите новый пароль"
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
                  {passwordBusy ? "…" : "Сменить пароль"}
                </button>
              </div>
            </section>
          </>
        )}

        {section === "agent" && leaf !== "connect" && (
          <div className={styles.footerBar}>
            <button type="submit">Сохранить</button>
            {saved && <span className={styles.ok}>Сохранено</span>}
          </div>
        )}
      </form>
    </div>
  );
}
