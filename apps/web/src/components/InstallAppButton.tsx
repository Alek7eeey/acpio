import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import styles from "./InstallAppButton.module.css";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

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
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIos(isIosDevice());

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in navigator && Boolean((navigator as { standalone?: boolean }).standalone));
    if (standalone) {
      setInstalled(true);
      return;
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setInstalled(true);
      setOpen(false);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
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
    if (deferred) {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
      setOpen(false);
      return;
    }
    // iOS has no beforeinstallprompt — show Safari Add to Home Screen steps.
    // Other browsers without a deferred prompt: show short fallback tips.
    setOpen((v) => !v);
  };

  const showIosGuide = ios || !deferred;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.btn}${className ? ` ${className}` : ""}${open ? ` ${styles.btnActive}` : ""}`}
        title={t("common.installApp")}
        aria-label={t("common.installApp")}
        aria-expanded={open}
        aria-haspopup={deferred && !ios ? undefined : "dialog"}
        onClick={() => void runInstall()}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
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
      {open && showIosGuide
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
                  <p className={styles.menuText}>{t("common.installAppHint")}</p>
                  <ul className={styles.menuList}>
                    <li>{t("common.installAppAndroid")}</li>
                    <li>{t("common.installAppDesktop")}</li>
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
