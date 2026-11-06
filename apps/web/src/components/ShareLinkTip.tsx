import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyLink } from "../lib/shareLink";
import styles from "./ShareLinkTip.module.css";

export type ShareLinkTipState = {
  x: number;
  y: number;
  link: string;
  /** What the tip says was copied ("Ссылка на чат…", "Ссылка на сообщение…"). */
  label: string;
};

/** How long a copied link stays on screen. */
const TIP_MS = 2600;

/**
 * The "link copied" tip every share command hangs by the place it was invoked
 * from — a message's button, a chat row's menu, a board card's menu. The tip
 * carries the link itself, so a clipboard the browser refused is still
 * readable and copyable by hand.
 */
export function useShareLinkTip() {
  const [tip, setTip] = useState<ShareLinkTipState | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const shareLink = useCallback(async (link: string, label: string, x: number, y: number) => {
    try {
      await copyLink(link);
    } catch {
      return;
    }
    setTip({
      x: Math.min(x, window.innerWidth - 240),
      y: Math.min(y + 6, window.innerHeight - 80),
      link,
      label,
    });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setTip(null), TIP_MS);
  }, []);

  return { tip, shareLink };
}

export function ShareLinkTip({ tip }: { tip: ShareLinkTipState | null }) {
  if (!tip) return null;
  return createPortal(
    <div className={styles.tip} style={{ left: tip.x, top: tip.y }} role="status">
      <span className={styles.label}>{tip.label}</span>
      <code className={styles.link}>{tip.link}</code>
    </div>,
    document.body,
  );
}
