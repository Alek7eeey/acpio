import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
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
    const t = window.setTimeout(() => setMinElapsed(true), MIN_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!ready || !minElapsed) return;
    beginExit();
  }, [ready, minElapsed, beginExit]);

  const onSkip = () => {
    if (finishedRef.current || exiting) return;
    setSkipping(true);
    setMinElapsed(true);
    if (readyRef.current) beginExit();
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
      aria-label="Loading ACProcess"
      title="Нажмите, чтобы пропустить"
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

        <p className={styles.sub}>Harness for agents</p>
        <p className={styles.hint}>Нажмите, чтобы продолжить</p>
      </div>
    </div>
  );
}
