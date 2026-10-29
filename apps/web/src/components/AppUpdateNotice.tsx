import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { RESTART_TIMEOUT, useAppUpdate } from "../lib/appUpdate";
import styles from "./AppUpdateNotice.module.css";

/** The popup's own width; narrower than this on a phone, it fits the viewport. */
const POPUP_WIDTH = 320;

/**
 * The chip beside the app's name and version, and the popup it opens: npm has
 * a newer Acpio, its number is right there next to the running one, and the
 * button downloads it, restarts the server onto it and reloads the page that
 * build serves. Nothing is shown while this build is the newest.
 */
export function AppUpdateNotice() {
  const t = useT();
  const update = useAppUpdate();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // Anchored under the chip, clamped to the viewport — the same placement the
  // install button's menu uses, since the header is where both live. Measured
  // after every render and kept identical while nothing moves: the header
  // re-lays itself out (the tree opens, the chip appears) without a resize
  // event, and a popup anchored to yesterday's position would float away.
  useLayoutEffect(() => {
    if (!update.open || !triggerRef.current) {
      setPos(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(POPUP_WIDTH, window.innerWidth - 16);
    const next = {
      top: rect.bottom + 8,
      left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
      width,
    };
    setPos((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.width === next.width
        ? prev
        : next,
    );
  });

  // Scrolling and resizing move the chip without re-rendering anything.
  useEffect(() => {
    if (!update.open) return;
    const measure = () => setPos((prev) => (prev ? { ...prev } : prev));
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [update.open]);

  // A popup that appeared by itself must go away the ordinary ways: a press
  // outside it, or Escape.
  const { open, dismiss } = update;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, dismiss]);

  const state = update.state;
  if (!state?.available || !state.latest) return null;

  const { phase } = update;
  const triggerLabel = t("update.trigger", { version: state.latest });
  const failure =
    update.error === RESTART_TIMEOUT ? t("update.restartTimeout") : update.error;
  const busy = phase === "installing" || phase === "restarting";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={update.open}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={update.toggle}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 19V5m0 0-5 5m5-5 5 5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className={styles.triggerVersion}>{state.latest}</span>
      </button>
      {update.open && pos
        ? createPortal(
            <div
              ref={popupRef}
              className={styles.popup}
              role="dialog"
              aria-label={t("update.title")}
              aria-busy={busy}
              style={{ top: pos.top, left: pos.left, width: pos.width }}
            >
              <div className={styles.head}>
                <span className={styles.title}>{t("update.title")}</span>
                <button
                  type="button"
                  className={styles.close}
                  aria-label={t("common.close")}
                  title={t("common.close")}
                  onClick={update.dismiss}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M6 6l12 12M18 6 6 18"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
              <p className={styles.versions}>
                {t("update.versions", { current: state.current, latest: state.latest })}
              </p>
              <p className={styles.body}>
                {phase === "installing"
                  ? t("update.installing")
                  : phase === "restarting"
                    ? t("update.restarting")
                    : phase === "failed"
                      ? t("update.failed")
                      : t("update.body")}
              </p>
              {phase === "failed" && failure ? (
                <pre className={styles.log}>{failure}</pre>
              ) : null}
              {busy ? (
                <div className={styles.busy} role="status">
                  <span className={styles.spinner} aria-hidden />
                </div>
              ) : (
                <div className={styles.actions}>
                  <button type="button" className={styles.primary} onClick={update.start}>
                    {phase === "failed" ? t("update.retry") : t("update.action")}
                  </button>
                  <button type="button" className={styles.secondary} onClick={update.dismiss}>
                    {t("update.later")}
                  </button>
                </div>
              )}
              {phase === "idle" || phase === "failed" ? (
                <p className={styles.warning}>{t("update.restartWarning")}</p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
