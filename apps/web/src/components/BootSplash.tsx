import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useT } from "../lib/i18n";
import styles from "./BootSplash.module.css";

const BRAND = "ACProcess";
const MIN_MS = 2600;
const EXIT_MS = 320;

type BootSplashProps = {
  /** When true, splash may begin exit (bootstrap finished). */
  ready: boolean;
  onDone: () => void;
};

export function BootSplash({ ready, onDone }: BootSplashProps) {
  const t = useT();
  const [minElapsed, setMinElapsed] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [exiting, setExiting] = useState(false);
  const finishedRef = useRef(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const beginExit = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setExiting(true);
    window.setTimeout(() => {
      onDone();
    }, EXIT_MS);
  }, [onDone]);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinElapsed(true), MIN_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || !minElapsed) return;
    beginExit();
  }, [ready, minElapsed, beginExit]);

  const onSkip = () => {
    if (finishedRef.current || exiting) return;
    setSkipping(true);
    setMinElapsed(true);
    beginExit();
  };

  return (
    <div
      className={[
        styles.splash,
        skipping ? styles.skipping : "",
        exiting ? styles.exiting : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
      aria-label={t("common.loadingApp")}
      title={t("common.skipSplash")}
      onClick={onSkip}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Escape") {
          e.preventDefault();
          onSkip();
        }
      }}
      tabIndex={0}
    >
      <div className={styles.glowA} aria-hidden />
      <div className={styles.glowB} aria-hidden />
      <div className={styles.grid} aria-hidden />

      <div className={styles.stage}>
        <div className={styles.ring} aria-hidden />
        <div className={styles.ringSoft} aria-hidden />

        <div className={styles.brand} aria-hidden>
          {BRAND.split("").map((ch, i) => (
            <span
              key={`${ch}-${i}`}
              className={`${styles.letter}${i < 3 ? ` ${styles.accent}` : ""}`}
              style={{ "--i": i } as CSSProperties}
            >
              {ch}
            </span>
          ))}
        </div>

        <p className={styles.sub}>{t("common.harnessForAgents")}</p>
        <p className={styles.hint}>{t("common.continueSplash")}</p>
      </div>
    </div>
  );
}
