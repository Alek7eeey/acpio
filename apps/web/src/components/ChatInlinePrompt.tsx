import { useState } from "react";
import { useAppStore } from "../lib/store";
import { useT } from "../lib/i18n";
import styles from "./ChatInlinePrompt.module.css";
type PermissionOption = { optionId: string; name?: string; kind?: string };

type ToolCallPermission = {
  title?: string;
  kind?: string;
  content?: unknown;
  locations?: Array<{ path?: string }>;
  rawInput?: unknown;
};

function optionRank(o: PermissionOption) {
  const kind = o.kind ?? "";
  const id = o.optionId;
  if (kind === "allow_once" || kind === "allow-once" || /allow[_-]?once/i.test(id)) return 0;
  if (kind === "allow_always" || kind === "allow-always" || /allow[_-]?always/i.test(id)) return 1;
  return 2;
}

function optionTone(o: PermissionOption): "primary" | "secondary" | "danger" {
  const kind = o.kind ?? "";
  const id = o.optionId;
  if (kind === "allow_once" || kind === "allow-once" || (/allow/i.test(id) && !/always/i.test(id))) {
    return "primary";
  }
  if (kind === "allow_always" || kind === "allow-always" || /always/i.test(id)) {
    return "secondary";
  }
  return "danger";
}

function textFromUnknown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromUnknown(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    for (const key of ["text", "content", "title", "description", "query", "url", "path", "command"]) {
      const nested = textFromUnknown(row[key]);
      if (nested) return nested;
    }
  }
  return "";
}

/** Prefer fields the agent sent; never invent friendly tool labels. */
function permissionCopy(payload: Record<string, unknown>, toolCall: ToolCallPermission) {
  const title =
    String(payload.title ?? "").trim() ||
    String(toolCall.title ?? "").trim() ||
    "";
  const detail =
    String(payload.description ?? "").trim() ||
    textFromUnknown(toolCall.content) ||
    textFromUnknown(toolCall.rawInput) ||
    toolCall.locations?.map((loc) => String(loc?.path ?? "").trim()).find(Boolean) ||
    "";
  return { title, detail: detail && detail !== title ? detail : "" };
}

export function ChatInlinePrompt({
  onAcceptPlan,
  onDismissPlan,
  askPace = false,
  busy = false,
}: {
  /** Approve the plan and start the work: the harness flips the plan's stage and,
   *  when nobody's turn is parked on the card, starts the turn itself. With a
   *  plan file the pace is asked first and handed over here. */
  onAcceptPlan?: (pacing?: "whole" | "step") => void;
  /** Close the card without answering it: the parked turn ends, the plan stays a
   *  draft, and the reader is free to write what to change. */
  onDismissPlan?: () => void;
  /** The plan lives in a file: the pace is a choice, not a default. */
  askPace?: boolean;
  /** An answer is already on its way — the buttons must not ask twice. */
  busy?: boolean;
}) {
  const t = useT();
  const pendingPermission = useAppStore((s) => s.pendingPermission);
  const permissionQueue = useAppStore((s) => s.permissionQueue);
  const pendingQuestion = useAppStore((s) => s.pendingQuestion);
  const answerPermission = useAppStore((s) => s.answerPermission);
  const answerQuestion = useAppStore((s) => s.answerQuestion);
  // «Одобрить» opens the pace, «Всё сразу / По одному» approves with it.
  const [paceOpen, setPaceOpen] = useState(false);

  if (pendingPermission) {
    const payload = pendingPermission.payload as Record<string, unknown>;
    const toolCall = (payload.toolCall ?? {}) as ToolCallPermission;
    const { title, detail } = permissionCopy(payload, toolCall);
    const options =
      (payload.options as PermissionOption[] | undefined)?.filter((o) => o?.optionId) ?? [];
    const buttons: PermissionOption[] =
      options.length > 0
        ? [...options].sort((a, b) => optionRank(a) - optionRank(b))
        : [
            { optionId: "allow-once", kind: "allow_once", name: t("permission.allowOnce") },
            { optionId: "allow-always", kind: "allow_always", name: t("permission.allowAlways") },
            { optionId: "reject-once", kind: "reject_once", name: t("permission.reject") },
          ];

    const labelFor = (opt: PermissionOption) => {
      const tone = optionTone(opt);
      if (tone === "primary") return t("permission.allowOnce");
      if (tone === "secondary") return t("permission.allowAlways");
      return t("permission.reject");
    };

    const queued = permissionQueue.length;

    return (
      <div className={styles.card} role="group" aria-label={t("permission.title")}>
        <div className={styles.eyebrow}>
          {t("permission.title")}
          {queued > 0 ? ` · +${queued}` : ""}
        </div>
        <div className={styles.title}>{title || t("permission.description")}</div>
        {detail ? <p className={styles.overview}>{detail}</p> : null}
        <div className={styles.actions}>
          {buttons.map((opt) => {
            const tone = optionTone(opt);
            return (
              <button
                key={opt.optionId}
                type="button"
                className={
                  tone === "primary"
                    ? styles.primary
                    : tone === "danger"
                      ? styles.danger
                      : styles.ghost
                }
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void answerPermission(opt.optionId);
                }}
              >
                {labelFor(opt)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (pendingQuestion?.kind === "create_plan") {
    const name = String(pendingQuestion.payload.name ?? "").trim() || t("question.plan");
    const overview = String(pendingQuestion.payload.overview ?? "").trim();
    return (
      <div
        className={`${styles.card}${onDismissPlan ? ` ${styles.withClose}` : ""}`}
        role="group"
        aria-label={t("question.plan")}
      >
        <div className={styles.eyebrow}>{t("question.planReady")}</div>
        <div className={styles.title}>{name}</div>
        {overview ? <p className={styles.overview}>{overview}</p> : null}
        {paceOpen && onAcceptPlan ? (
          <div className={styles.pacePop} role="dialog" aria-label={t("question.planPace")}>
            <div className={styles.pacePopTitle}>{t("question.planPace")}</div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                disabled={busy}
                onClick={() => onAcceptPlan("whole")}
              >
                {t("planPanel.pacingWhole")}
              </button>
              <button
                type="button"
                className={styles.ghost}
                disabled={busy}
                onClick={() => onAcceptPlan("step")}
              >
                {t("planPanel.pacingStep")}
              </button>
            </div>
          </div>
        ) : null}
        {/* No «открыть план» here: the panel opens itself the moment the plan is
            composed, and a second way to the same document above the input only
            crowded the two answers the card is really about. */}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.danger}
            disabled={busy}
            onClick={() =>
              void answerQuestion({ outcome: { outcome: "rejected", reason: "rejected by user" } })
            }
          >
            {t("common.reject")}
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => {
              if (!onAcceptPlan) {
                void answerQuestion({ outcome: { outcome: "accepted" } });
                return;
              }
              if (askPace) {
                setPaceOpen(true);
                return;
              }
              onAcceptPlan();
            }}
          >
            {t("question.planApprove")}
          </button>
        </div>
        {onDismissPlan ? (
          <button
            type="button"
            className={styles.cardClose}
            disabled={busy}
            aria-label={t("question.planDismiss")}
            title={t("question.planDismiss")}
            onClick={onDismissPlan}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
      </div>
    );
  }
  if (pendingQuestion?.kind === "switch_mode") {
    const mode = String(pendingQuestion.payload.mode ?? "").trim() || "plan";
    const modeName = t(`modes.${mode}`) || mode;
    return (
      <div className={styles.card} role="group" aria-label={t("question.modeSwitch")}>
        <div className={styles.eyebrow}>{t("question.modeSwitch")}</div>
        <div className={styles.title}>{t("question.modeSwitchTitle", { mode: modeName })}</div>
        <p className={styles.overview}>{t("question.modeSwitchHint")}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.danger}
            onClick={() =>
              void answerQuestion({ outcome: { outcome: "rejected", reason: "rejected by user" } })
            }
          >
            {t("common.reject")}
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void answerQuestion({ outcome: { outcome: "accepted" } })}
          >
            {t("common.accept")}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
