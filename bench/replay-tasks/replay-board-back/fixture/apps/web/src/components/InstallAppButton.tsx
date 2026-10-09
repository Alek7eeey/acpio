import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import {
  getDeferredInstallPrompt,
  initPwaInstallCapture,
  isPwaInstalled,
  promptPwaInstall,
  subscribePwaInstall,
} from "../lib/pwaInstall";
import styles from "./InstallAppButton.module.css";

type InstallAppButtonProps = {
  className?: string;
};

function isIosDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const iPadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iOS || iPadOs;
}

export function InstallAppButton({ className }: InstallAppButtonProps) {
  const t = useT();
  const [deferredReady, setDeferredReady] = useState(() => Boolean(getDeferredInstallPrompt()));
  const [installed, setInstalled] = useState(() => isPwaInstalled());
  const [ios] = useState(() => isIosDevice());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initPwaInstallCapture();
    const sync = () => {
      setDeferredReady(Boolean(getDeferredInstallPrompt()));
      setInstalled(isPwaInstalled());
    };
    sync();
    return subscribePwaInstall(sync);
  }, []);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) {
      setMenuPos(null);
      return;
    }
    const place = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(300, window.innerWidth - 16);
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
      setMenuPos({ top: rect.bottom + 6, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (installed) return null;

  const runInstall = async () => {
    if (busy) return;

    // Chrome/Edge: native install dialog from deferred beforeinstallprompt.
    if (getDeferredInstallPrompt()) {
      setBusy(true);
      setOpen(false);
      try {
        const outcome = await promptPwaInstall();
        if (outcome === "unavailable") setOpen(true);
      } finally {
        setBusy(false);
      }
      return;
    }

    // BIP may arrive right after SW activates — wait briefly before showing hints.
    if (!ios && "serviceWorker" in navigator) {
      setBusy(true);
      try {
        await navigator.serviceWorker.ready;
        await new Promise<void>((resolve) => {
          if (getDeferredInstallPrompt()) {
            resolve();
            return;
          }
          const done = () => {
            window.clearTimeout(timer);
            unsub();
            resolve();
          };
          const unsub = subscribePwaInstall(() => {
            if (getDeferredInstallPrompt()) done();
          });
          const timer = window.setTimeout(done, 2500);
        });
        if (getDeferredInstallPrompt()) {
          setOpen(false);
          const outcome = await promptPwaInstall();
          if (outcome === "unavailable") setOpen(true);
          return;
        }
      } finally {
        setBusy(false);
      }
    }

    // iOS or Chromium without a ready prompt → show instructions / status.
    setOpen((v) => !v);
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.btn}${className ? ` ${className}` : ""}${open ? ` ${styles.btnActive}` : ""}`}
        title={t("common.installApp")}
        aria-label={t("common.installApp")}
        aria-expanded={open}
        aria-haspopup={deferredReady && !ios ? undefined : "dialog"}
        disabled={busy}
        onClick={() => void runInstall()}
      >
        <svg className={styles.icon} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3v10m0 0l-3.5-3.5M12 13l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5 17.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.menu}
              role="dialog"
              aria-label={t("common.installApp")}
              style={
                menuPos
                  ? { top: menuPos.top, left: menuPos.left, width: Math.min(300, window.innerWidth - 16) }
                  : { visibility: "hidden", top: 0, left: 0 }
              }
            >
              <div className={styles.menuTitle}>{t("common.installApp")}</div>
              {ios ? (
                <>
                  <p className={styles.menuText}>{t("common.installAppIosHint")}</p>
                  <ol className={styles.menuListOrdered}>
                    <li>{t("common.installAppIosStep1")}</li>
                    <li>{t("common.installAppIosStep2")}</li>
                    <li>{t("common.installAppIosStep3")}</li>
                  </ol>
                </>
              ) : (
                <>
                  <p className={styles.menuText}>{t("common.installAppWaiting")}</p>
                  <ul className={styles.menuList}>
                    <li>{t("common.installAppNeedHttps")}</li>
                    <li>{t("common.installAppNeedSw")}</li>
                    <li>{t("common.installAppAndroid")}</li>
                  </ul>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
