import { useEffect, useRef, useState, type CSSProperties } from "react";
import styles from "./BootSplash.module.css";

const BRAND = "ACProcess";
const MIN_MS = 2600;
const EXIT_MS = 480;

type BootSplashProps = {
  /** When true, splash may begin exit (bootstrap finished). */
  ready: boolean;
  onDone: () => void;
};

export function BootSplash({ ready, onDone }: BootSplashProps) {
  const [minElapsed, setMinElapsed] = useState(false);
  const [exiting, setExiting] = useState(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    const t = window.setTimeout(() => setMinElapsed(true), MIN_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!ready || !minElapsed || finishedRef.current) return;
    finishedRef.current = true;
    setExiting(true);
    const t = window.setTimeout(() => {
      onDone();
    }, EXIT_MS);
    // Do not clear this timeout on Strict Mode cleanup — otherwise onDone never runs
    // and the faded splash stays mounted over an empty tree (black screen).
    return () => {
      // keep timer; finishedRef prevents double schedule
      void t;
    };
  }, [ready, minElapsed, onDone]);

  return (
    <div
      className={`${styles.splash}${exiting ? ` ${styles.exiting}` : ""}`}
      role="status"
      aria-live="polite"
      aria-label="Loading ACProcess"
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
      </div>
    </div>
  );
}
