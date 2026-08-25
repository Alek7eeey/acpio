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
import styles from "./PlanSidePanel.module.css";

const WIDTH_KEY = "acprocess.planPanelWidth.v1";
const WIDTH_MIN = 280;
const WIDTH_MAX = 720;
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
  onClose,
  onAccept,
  onReject,
}: {
  plan: PlanPayload | null;
  open: boolean;
  pending?: boolean;
  onClose: () => void;
  onAccept?: () => void;
  onReject?: () => void;
}) {
  const t = useT();
  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
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
      if (window.innerWidth < 900) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
    },
    [width],
  );

  const onSplitterDoubleClick = useCallback(() => {
    if (window.innerWidth < 900) return;
    setWidth(WIDTH_DEFAULT);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Dragging left grows the right panel.
      const max = Math.min(WIDTH_MAX, Math.floor(window.innerWidth * 0.55));
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

  return (
    <aside
      className={`${styles.panel} ${dragging ? styles.resizing : ""}`}
      aria-label={t("planPanel.title")}
      style={{ ["--plan-panel-width"]: `${width}px` } as CSSProperties}
    >
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
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>{t("planPanel.title")}</span>
          {pending ? <span className={styles.pendingBadge}>{t("question.planAwaiting")}</span> : null}
        </div>
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
      <div className={styles.body}>
        <PlanApprovalBody payload={plan} fallbackTitle={t("question.plan")} scrollable={false} />
      </div>
      {pending && onAccept && onReject ? (
        <div className={styles.footer}>
          <button type="button" className={styles.danger} onClick={onReject}>
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
          <button type="button" className={styles.primary} onClick={onAccept}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M5 12.5l5 5L19 7.5"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t("common.accept")}</span>
          </button>
        </div>
      ) : null}
    </aside>
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
