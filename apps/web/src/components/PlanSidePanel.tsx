import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { PlanApprovalBody, type PlanPayload } from "./PlanApprovalBody";
import { useT } from "../lib/i18n";
import { isSidePanelResizeAllowed } from "../lib/panelLayout";
import styles from "./PlanSidePanel.module.css";

const WIDTH_KEY = "acpio.planPanelWidth.v1";
const WIDTH_MIN = 280;
const WIDTH_MAX = 1100;
const WIDTH_DEFAULT = 380;

function readStoredWidth() {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  } catch {
    /* ignore */
  }
  return WIDTH_DEFAULT;
}

export function PlanSidePanel({
  plan,
  open,
  pending,
  fillPane = false,
  onClose,
  onRemove,
  onAccept,
  onReject,
  onApprove,
  onPacing,
  onReadText,
  onWriteText,
  approving = false,
}: {
  plan: PlanPayload | null;
  open: boolean;
  pending?: boolean;
  /** Take the full chat column instead of a fixed side width. */
  fillPane?: boolean;
  onClose: () => void;
  /** Drop the plan from the panel entirely; absent while it waits for an answer. */
  onRemove?: () => void;
  /** Answer the waiting card's own question: the plan starts implementing. */
  onAccept?: () => void;
  onReject?: () => void;
  /** Draft stage: approve the plan and start implementing. */
  onApprove?: () => void;
  /** Switch the pace the steps are done at — before the work starts or during it. */
  onPacing?: (pacing: "whole" | "step") => void;
  /** The plan file on disk, verbatim: what the manual editor opens. */
  onReadText?: () => Promise<string>;
  /** Replace the plan file with the reader's own text. */
  onWriteText?: (text: string) => Promise<void>;
  /** An approval is already on its way — the footer must not ask twice. */
  approving?: boolean;
}) {
  const t = useT();
  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  // Full screen is a reading mode of its own: the plan takes the whole window
  // and the chat underneath stops stealing the width the panel needs.
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyEdit, setBusyEdit] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* ignore */
    }
  }, [width]);

  const onSplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidePanelResizeAllowed()) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
    },
    [width],
  );

  const onSplitterDoubleClick = useCallback(() => {
    if (!isSidePanelResizeAllowed()) return;
    setWidth(WIDTH_DEFAULT);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Dragging left grows the right panel — up to a fifth of the window still
      // left for the chat.
      const max = Math.min(WIDTH_MAX, Math.floor(window.innerWidth * 0.8));
      const next = drag.startWidth - (e.clientX - drag.startX);
      setWidth(Math.min(max, Math.max(WIDTH_MIN, next)));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  // Escape leaves the full-screen mode and nothing else: the panel itself stays
  // where it was, the way a reader who just wanted the chat back expects.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add(styles.resizingBody);
    return () => {
      document.body.style.cursor = prev;
      document.body.classList.remove(styles.resizingBody);
    };
  }, [dragging]);

  if (!open || !plan) return null;

  const stage = String(plan.stage ?? "").trim();
  const pacing = String(plan.pacing ?? "").trim() === "step" ? "step" : "whole";
  const todos = plan.todos ?? [];
  const done = todos.filter((todo) =>
    /^(completed|complete)$/i.test(String(todo.status ?? "")),
  ).length;
  const stageLabel =
    stage === "applying"
      ? t("planPanel.stageApplying")
      : stage === "draft"
        ? t("planPanel.stageDraft")
        : "";
  // The footer answers the stage the file declares: a draft can be approved, an
  // approved plan can be paced, and a card waiting for an answer is neither.
  const reviewing = Boolean(pending && onAccept && onReject);
  // One way in, whatever the plan's stage: the card's own answer while a turn
  // is parked on it, the panel's own «approve» for a draft nobody waits on.
  const approve = reviewing ? onAccept : stage === "draft" ? onApprove : undefined;
  const canApprove = Boolean(approve) && (reviewing || todos.length > 0);
  // The pace is the reader's before the work starts, not only after it does —
  // including while the approval card waits: that is the pace it will start at.
  const canPace = Boolean(onPacing) && Boolean(stage);
  // The file itself, for the reader who would rather edit the plan than the
  // switches: only a plan that lives in a file can be edited this way.
  const canEdit = Boolean(plan.path && onReadText && onWriteText);

  /**
   * The pencil opens the editor at once and fills it when the file's text lands:
   * the button is the reader's the whole time, whatever the round trip does. It
   * used to grey itself out until the read came back, and a read that took its
   * time made the plan look uneditable for as long as the agent was working.
   */
  const startEditing = async () => {
    if (!onReadText) return;
    setEditing(true);
    setBusyEdit(true);
    try {
      const text = await onReadText();
      // Whatever the reader already typed is theirs: the file that arrives late
      // must not type over it.
      setDraft((prev) => (prev.trim() ? prev : text));
    } catch {
      // Nothing to edit, so nothing is opened; the banner carries the reason.
      setEditing(false);
    } finally {
      setBusyEdit(false);
    }
  };

  const saveEditing = async () => {
    if (!onWriteText) return;
    setBusyEdit(true);
    try {
      await onWriteText(draft);
      setEditing(false);
    } catch {
      // Keep the text: a failed save must not throw the reader's edit away.
    } finally {
      setBusyEdit(false);
    }
  };

  return (
    <aside
      className={`${styles.panel}${fillPane ? ` ${styles.panelFill}` : ""}${expanded ? ` ${styles.panelExpanded}` : ""} ${dragging ? styles.resizing : ""}`}
      aria-label={t("planPanel.title")}
      style={{ ["--plan-panel-width"]: `${width}px` } as CSSProperties}
    >
      {!fillPane && !expanded ? (
      <div
        className={styles.splitter}
        onPointerDown={onSplitterDown}
        onDoubleClick={onSplitterDoubleClick}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("common.resizePlan")}
        aria-valuenow={width}
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={WIDTH_MAX}
        title={t("common.resizePlanHint")}
      />
      ) : null}
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>{t("planPanel.title")}</span>
          {pending ? <span className={styles.pendingBadge}>{t("question.planAwaiting")}</span> : null}
          {stageLabel ? (
            <span className={styles.stageChip} data-stage={stage}>
              {stageLabel}
            </span>
          ) : null}
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.expandBtn}
            aria-pressed={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            aria-label={t(expanded ? "planPanel.collapse" : "planPanel.expand")}
            title={t(expanded ? "planPanel.collapse" : "planPanel.expand")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              {expanded ? (
                <path
                  d="M9 4v5H4M15 20v-5h5M4 9l5-5M20 15l-5 5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M14 4h6v6M20 4l-6 6M10 20H4v-6M4 20l6-6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </button>
          {canEdit && !editing ? (
            <button
              type="button"
              className={styles.editBtn}
              aria-busy={busyEdit}
              onClick={() => void startEditing()}
              aria-label={t("planPanel.edit")}
              title={t("planPanel.edit")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 20h4l10-10a2.5 2.5 0 0 0-4-4L4 16v4Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              className={styles.removeBtn}
              onClick={onRemove}
              aria-label={t("planPanel.remove")}
              title={t("planPanel.remove")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={t("common.cancel")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
      {plan.path ? (
        <div className={styles.meta}>
          <code className={styles.metaPath} title={plan.path}>
            {plan.path}
          </code>
          {todos.length > 0 ? (
            <span className={styles.progress}>
              {t("planPanel.progress", { done, total: todos.length })}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.body}>
        {editing ? (
          <textarea
            className={styles.editor}
            aria-label={t("planPanel.editHint")}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : (
          <PlanApprovalBody payload={plan} fallbackTitle={t("question.plan")} scrollable={false} />
        )}
      </div>
      {editing ? (
        <div className={styles.footer}>
          {/* Cancel is the reader's in every state — a read still on its way
              must not be a box they cannot get out of. */}
          <button type="button" className={styles.danger} onClick={() => setEditing(false)}>
            <span>{t("common.cancel")}</span>
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={busyEdit}
            onClick={() => void saveEditing()}
          >
            <span>{t("planPanel.save")}</span>
          </button>
        </div>
      ) : null}
      {!editing && canApprove ? (
        <div className={reviewing ? styles.footer : styles.footerSingle}>
          {reviewing ? (
            <button
              type="button"
              className={styles.danger}
              disabled={approving}
              onClick={onReject}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <span>{t("common.reject")}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={styles.primary}
            disabled={approving}
            onClick={() => approve?.()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M5 12.5l5 5L19 7.5"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t("planPanel.approve")}</span>
          </button>
        </div>
      ) : null}
      {!editing && canPace ? (
        <div className={styles.footerPace}>
          <span className={styles.paceLabel}>{t("planPanel.pacing")}</span>
          <PlanPaceChoice value={pacing} onChange={(option) => onPacing?.(option)} />
        </div>
      ) : null}
    </aside>
  );
}

/**
 * The pace, as a two-state switch: approving a plan keeps whatever the reader
 * picked here, and switching it later re-paces the work already running.
 */
export function PlanPaceChoice({
  value,
  onChange,
}: {
  value: "whole" | "step";
  onChange: (pacing: "whole" | "step") => void;
}) {
  const t = useT();
  return (
    <div className={styles.paceGroup} role="group" aria-label={t("planPanel.pacing")}>
      {(["whole", "step"] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={`${styles.paceBtn} ${value === option ? styles.paceBtnActive : ""}`}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {t(option === "whole" ? "planPanel.pacingWhole" : "planPanel.pacingStep")}
        </button>
      ))}
    </div>
  );
}

export function PlanTabButton({
  visible,
  open,
  pending,
  onClick,
}: {
  visible: boolean;
  open: boolean;
  pending?: boolean;
  onClick: () => void;
}) {
  const t = useT();
  if (!visible) return null;
  return (
    <button
      type="button"
      className={`${styles.tab} ${open ? styles.tabActive : ""} ${pending ? styles.tabPending : ""}`}
      onClick={onClick}
      aria-pressed={open}
      title={t("planPanel.title")}
      aria-label={t("planPanel.title")}
    >
      <svg className={styles.tabIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M8 6h13M8 12h13M8 18h9"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M4 6h.01M4 12h.01M4 18h.01"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
      {pending ? <span className={styles.tabDot} aria-hidden /> : null}
    </button>
  );
}
