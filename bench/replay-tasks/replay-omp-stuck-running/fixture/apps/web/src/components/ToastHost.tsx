import { useEffect, useState } from "react";
import {
  dismissToast,
  subscribeToasts,
  type ToastItem,
  type ToastTone,
} from "../lib/toast";
import styles from "./ToastHost.module.css";

function toneClass(tone: ToastTone): string {
  if (tone === "success") return styles.success;
  if (tone === "danger") return styles.danger;
  return styles.info;
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M20 6.5 9.5 17 4 11.5"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (tone === "danger") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 8v5.5M12 16.8h.01"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        <path
          d="M12 3.8 21 19.2H3L12 3.8Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.85" />
      <path d="M12 11v5.2M12 8.2h.01" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setItems), []);

  if (!items.length) return null;

  return (
    <div className={styles.host} aria-live="polite" aria-relevant="additions text">
      {items.map((item) => (
        <div
          key={item.id}
          className={`${styles.toast} ${toneClass(item.tone)}`}
          role="status"
        >
          <span className={styles.icon} aria-hidden>
            <ToneIcon tone={item.tone} />
          </span>
          <span className={styles.message}>{item.message}</span>
          <button
            type="button"
            className={styles.close}
            aria-label="Dismiss"
            onClick={() => dismissToast(item.id)}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
