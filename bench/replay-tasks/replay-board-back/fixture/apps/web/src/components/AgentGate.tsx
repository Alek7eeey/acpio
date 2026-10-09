import type { ReactNode } from "react";
import { useT } from "../lib/i18n";
import { harnessLabel } from "../lib/harness";
import { useAppStore } from "../lib/store";
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
}: {
  titleId: string;
  title: string;
  lead: string;
  progress?: number;
  children: ReactNode;
  actionLabel: string;
  actionDisabled?: boolean;
  onAction: () => void;
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

export function AgentGate() {
  const t = useT();
  const adapters = useAppStore((s) => s.adapters);
  const availability = useAppStore((s) => s.agentAvailability);
  const probing = useAppStore((s) => s.agentProbing);
  const dismissAgentGate = useAppStore((s) => s.dismissAgentGate);

  // Enabled harnesses only, and nothing before /api/adapters answers: guessing
  // here could name an agent the user switched off.
  const ids: readonly string[] = adapters.map((a) => a.id);
  // Every harness switched off — there is nothing to check, so no gate.
  if (!ids.length) return null;
  const started = Object.keys(probing).length > 0 || Object.keys(availability).length > 0;
  const settled = ids.filter((id) => started && !probing[id] && availability[id] != null).length;
  const checking = !started || ids.some((id) => probing[id] || availability[id] == null);

  return (
    <GateShell
      titleId="agent-gate-title"
      title={t("common.agentGateTitle")}
      lead={t("common.agentGateLead")}
      progress={ids.length ? settled / ids.length : 0}
      actionLabel={t("common.agentGateContinue")}
      actionDisabled={checking}
      onAction={() => dismissAgentGate()}
    >
      {ids.map((id) => {
        const loading = !started || probing[id] || availability[id] == null;
        return (
          <AgentRow
            key={id}
            label={harnessLabel(id, adapters)}
            loading={loading}
            online={availability[id] === true}
            checkingLabel={t("common.agentChecking")}
            onlineLabel={t("common.online")}
            offlineLabel={t("common.offline")}
          />
        );
      })}
    </GateShell>
  );
}

export function AgentOfflineWarning() {
  const t = useT();
  const adapters = useAppStore((s) => s.adapters);
  const ids = useAppStore((s) => s.agentOfflineWarning);
  const dismiss = useAppStore((s) => s.dismissAgentOfflineWarning);
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
