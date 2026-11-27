import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { mergeClientAppSettings, type AppSettings } from "@acpio/shared";
import { api } from "../lib/api";
import { applyAppearance } from "../lib/appearance";
import { useT } from "../lib/i18n";
import { harnessLabel, isBuiltinFamilyAdapter, isBuiltinFamilyProvider } from "../lib/harness";
import { settingsPath } from "../lib/settingsNav";
import { useAppStore } from "../lib/store";
import { PickButton } from "./PathPickField";
import styles from "./AgentGate.module.css";

const agentMark = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="9" r="3.1" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M5.6 19.1c.8-3 3.4-4.9 6.4-4.9s5.6 1.9 6.4 4.9"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

function GateShell({
  titleId,
  title,
  lead,
  progress,
  children,
  actionLabel,
  actionDisabled,
  onAction,
  secondaryLabel,
  onSecondaryAction,
}: {
  titleId: string;
  title: string;
  lead: string;
  progress?: number;
  children: ReactNode;
  actionLabel: string;
  actionDisabled?: boolean;
  onAction: () => void;
  /** Optional ghost action under the primary one ("Got it" on a warning). */
  secondaryLabel?: string;
  onSecondaryAction?: () => void;
}) {
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.glowA} aria-hidden />
      <div className={styles.glowB} aria-hidden />
      <div className={styles.grid} aria-hidden />
      <div className={styles.dialog}>
        {progress != null ? (
          <div className={styles.progressTrack} aria-hidden>
            <span className={styles.progressFill} style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}
        <div className={styles.mark} aria-hidden>
          {agentMark}
        </div>
        <h1 id={titleId} className={styles.title}>
          {title}
        </h1>
        <p className={styles.lead}>{lead}</p>
        <div className={styles.list}>{children}</div>
        <button
          type="button"
          className={styles.continue}
          disabled={actionDisabled}
          onClick={onAction}
        >
          {actionLabel}
        </button>
        {secondaryLabel ? (
          <button type="button" className={styles.secondary} onClick={onSecondaryAction}>
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AgentRow({
  label,
  loading,
  online,
  checkingLabel,
  onlineLabel,
  offlineLabel,
}: {
  label: string;
  loading: boolean;
  online: boolean;
  checkingLabel: string;
  onlineLabel: string;
  offlineLabel: string;
}) {
  const stateClass =
    loading ? styles.rowWait : online ? styles.rowOk : styles.rowBad;
  return (
    <div className={`${styles.row} ${stateClass}`}>
      <span className={styles.avatar} aria-hidden>
        {loading ? <span className={styles.spin} /> : <span className={styles.dot} />}
      </span>
      <span className={styles.body}>
        <span className={styles.label}>{label}</span>
        <span className={styles.status}>
          {loading ? checkingLabel : online ? onlineLabel : offlineLabel}
        </span>
      </span>
    </div>
  );
}

/**
 * How long the gate holds its own Continue button back. A probe is a process
 * launch behind an ACP handshake, and one harness on a busy PC can burn the
 * whole 20s probe timeout — a first run (no stored availability yet) would then
 * sit in front of a disabled button with every row spinning. Past this budget
 * the check carries on in the background and the reader goes on with the app.
 */
const GATE_SLOW_CHECK_MS = 6000;

export function AgentGate() {
  const t = useT();
  const adapters = useAppStore((s) => s.adapters);
  const availability = useAppStore((s) => s.agentAvailability);
  const probing = useAppStore((s) => s.agentProbing);
  const dismissAgentGate = useAppStore((s) => s.dismissAgentGate);

  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsNote, setSettingsNote] = useState<{ ok: boolean; text: string } | null>(null);

  /**
   * Another install's settings file — the same endpoint Settings → Import
   * calls. This window is where a first run meets it, so the landing itself
   * matters: the harness rows above are read again afterwards, since the file
   * may switch a harness on or off.
   */
  const applySettingsFile = async (
    load: () => Promise<{ settings: AppSettings; applied: string[] }>,
  ) => {
    setSettingsBusy(true);
    setSettingsNote(null);
    try {
      const result = await load();
      const store = useAppStore.getState();
      // The same landing Settings → Import gives the shell, minus its full
      // reload: `loadBootstrap` flips `loading`, which unmounts this window —
      // and the answer to the import would go with it.
      const settings = mergeClientAppSettings(result.settings);
      store.applyTheme(settings.theme);
      store.applyLocale(settings.locale);
      applyAppearance(settings);
      useAppStore.setState({ settings });
      setSettingsNote({
        ok: true,
        text: t("common.agentGateTransferDone", { count: result.applied.length }),
      });
      await store.loadAdapters();
      await store.probeAllAgents({ force: true });
    } catch (err) {
      setSettingsNote({
        ok: false,
        text: t("common.agentGateTransferFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    } finally {
      setSettingsBusy(false);
    }
  };

  // Enabled harnesses only, and nothing before /api/adapters answers: guessing
  // here could name an agent the user switched off. Every enabled harness is
  // listed: the built-in agent — and every preset of it — runs inside the
  // server, so its row is green from the first frame and only the external
  // CLIs are checked, with their probes alone holding Continue back.
  const checkedIds: readonly string[] = adapters
    .filter((a) => !isBuiltinFamilyAdapter(a))
    .map((a) => a.id);
  const started = Object.keys(probing).length > 0 || Object.keys(availability).length > 0;
  const settled = checkedIds.filter(
    (id) => started && !probing[id] && availability[id] != null,
  ).length;
  const checking =
    checkedIds.length > 0 &&
    (!started || checkedIds.some((id) => probing[id] || availability[id] == null));

  // The rows keep resolving after the budget runs out — the probes belong to
  // the store, not to this window, so they answer whether it is still here.
  const [slowCheck, setSlowCheck] = useState(false);
  useEffect(() => {
    if (!checking) {
      setSlowCheck(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowCheck(true), GATE_SLOW_CHECK_MS);
    return () => window.clearTimeout(timer);
  }, [checking]);

  if (!adapters.length) return null;

  return (
    <GateShell
      titleId="agent-gate-title"
      title={t("common.agentGateTitle")}
      lead={t("common.agentGateLead")}
      progress={checkedIds.length ? settled / checkedIds.length : 1}
      actionLabel={t("common.agentGateContinue")}
      actionDisabled={checking && !slowCheck}
      onAction={() => dismissAgentGate()}
    >
      {adapters.map((adapter) => {
        const id = adapter.id;
        const inProcess = isBuiltinFamilyAdapter(adapter);
        const loading =
          !inProcess && (!started || probing[id] || availability[id] == null);
        return (
          <AgentRow
            key={id}
            label={harnessLabel(id, adapters)}
            loading={loading}
            online={inProcess || availability[id] === true}
            checkingLabel={t("common.agentChecking")}
            onlineLabel={t("common.online")}
            offlineLabel={t("common.offline")}
          />
        );
      })}
      {slowCheck ? (
        <p className={styles.slowNote} role="status">
          {t("common.agentGateSlowCheck")}
        </p>
      ) : null}
      <div className={styles.transfer}>
        <span className={styles.transferTitle}>{t("common.agentGateTransferTitle")}</span>
        <p className={styles.transferHint}>{t("common.agentGateTransferHint")}</p>
        <PickButton
          kind="file"
          accept="application/json,.json"
          className={styles.secondary}
          caption={
            settingsBusy
              ? t("common.agentGateTransferBusy")
              : t("common.agentGateTransferAction")
          }
          disabled={settingsBusy}
          onPickFile={(file) =>
            void applySettingsFile(async () =>
              api.importSettingsFile(JSON.parse(await file.text())),
            )
          }
          onPick={(pathOnServer) =>
            void applySettingsFile(() => api.importSettingsPath(pathOnServer))
          }
        />
        {settingsNote ? (
          <p className={settingsNote.ok ? styles.transferOk : styles.transferBad}>
            {settingsNote.text}
          </p>
        ) : null}
      </div>
    </GateShell>
  );
}

/**
 * A prompt aimed at a harness that cannot take it yet — the built-in agent
 * without an endpoint or a model. Raised by the send doors themselves (the
 * composer, a board card) before anything is queued, so the missing setting is
 * named instead of surfacing later as a failed turn.
 */
export function HarnessNotConfiguredWarning() {
  const t = useT();
  const navigate = useNavigate();
  const adapters = useAppStore((s) => s.adapters);
  const warning = useAppStore((s) => s.harnessNotConfigured);
  const dismiss = useAppStore((s) => s.dismissHarnessNotConfigured);
  if (!warning) return null;
  const label = harnessLabel(warning.provider, adapters);

  return (
    <GateShell
      titleId="harness-not-configured-title"
      title={t("common.harnessNotConfiguredTitle")}
      lead={t(
        warning.reason === "endpoint"
          ? "common.harnessNotConfiguredLeadEndpoint"
          : "common.harnessNotConfiguredLeadModel",
        { agent: label },
      )}
      actionLabel={t("common.harnessNotConfiguredOpenSettings")}
      onAction={() => {
        dismiss();
        navigate(settingsPath("builtin", "providers"));
      }}
      secondaryLabel={t("common.harnessNotConfiguredOk")}
      onSecondaryAction={() => dismiss()}
    >
      <AgentRow
        label={label}
        loading={false}
        online={false}
        checkingLabel={t("common.agentChecking")}
        onlineLabel={t("common.online")}
        offlineLabel={t("common.harnessNotConfiguredStatus")}
      />
    </GateShell>
  );
}

export function AgentOfflineWarning() {
  const t = useT();
  const adapters = useAppStore((s) => s.adapters);
  const wentOffline = useAppStore((s) => s.agentOfflineWarning);
  const dismiss = useAppStore((s) => s.dismissAgentOfflineWarning);
  // Same rule as the gate: the built-in agent's own status is noise — and a
  // preset of it is the same in-process agent under another name.
  const ids = wentOffline.filter((id) => !isBuiltinFamilyProvider(id, adapters));
  if (!ids.length) return null;

  return (
    <GateShell
      titleId="agent-offline-title"
      title={t("common.agentStoppedTitle")}
      lead={t("common.agentStoppedLead")}
      actionLabel={t("common.agentStoppedOk")}
      onAction={() => dismiss()}
    >
      {ids.map((id) => (
        <AgentRow
          key={id}
          label={harnessLabel(id, adapters)}
          loading={false}
          online={false}
          checkingLabel={t("common.agentChecking")}
          onlineLabel={t("common.online")}
          offlineLabel={t("common.offline")}
        />
      ))}
    </GateShell>
  );
}
