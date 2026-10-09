import { useState } from "react";
import { useT } from "../lib/i18n";
import {
  markNotificationPromptDismissed,
  requestNotificationPermission,
  shouldShowNotificationPrompt,
} from "../lib/notify";
import styles from "./NotificationPrompt.module.css";

export function NotificationPrompt() {
  const t = useT();
  const [visible, setVisible] = useState(() => shouldShowNotificationPrompt());

  if (!visible) return null;

  const dismiss = () => {
    markNotificationPromptDismissed();
    setVisible(false);
  };

  const enable = async () => {
    await requestNotificationPermission();
    dismiss();
  };

  return (
    <div className={styles.host} role="region" aria-label={t("common.notificationsPromptTitle")}>
      <div className={styles.card}>
        <span className={styles.icon} aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3.2a5.2 5.2 0 0 0-5.2 5.2v2.8c0 .8-.3 1.6-.8 2.2L4.8 16.2A1.2 1.2 0 0 0 6 18h12a1.2 1.2 0 0 0 1.2-1.8l-1.2-2.8a3.4 3.4 0 0 1-.8-2.2V8.4A5.2 5.2 0 0 0 12 3.2Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
            <path
              d="M9.4 18.2a2.6 2.6 0 0 0 5.2 0"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <div className={styles.copy}>
          <strong className={styles.title}>{t("common.notificationsPromptTitle")}</strong>
          <p className={styles.body}>{t("common.notificationsPromptBody")}</p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.laterBtn} onClick={dismiss}>
            {t("common.notificationsPromptLater")}
          </button>
          <button type="button" className={styles.enableBtn} onClick={() => void enable()}>
            {t("common.notificationsPromptEnable")}
          </button>
        </div>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={dismiss}
          aria-label={t("common.cancel")}
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
    </div>
  );
}
