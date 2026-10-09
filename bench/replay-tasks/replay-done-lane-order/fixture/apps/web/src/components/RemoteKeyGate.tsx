import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import styles from "./AgentGate.module.css";

export function RemoteKeyGate({ onUnlocked }: { onUnlocked: () => void }) {
  const t = useT();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = key.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(false);
    try {
      await api.unlockRemoteAccess(next);
      onUnlocked();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="remote-key-title">
      <div className={styles.glowA} aria-hidden />
      <div className={styles.glowB} aria-hidden />
      <div className={styles.grid} aria-hidden />
      <form className={styles.dialog} onSubmit={(e) => void submit(e)}>
        <h1 id="remote-key-title" className={styles.title}>
          {t("settings.remoteUnlockTitle")}
        </h1>
        <p className={styles.lead}>{t("settings.remoteUnlockLead")}</p>
        <div className={styles.list}>
          <input
            className={styles.keyInput}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setError(false);
            }}
            placeholder={t("settings.remoteKeyPlaceholder")}
            aria-label={t("settings.remoteUnlockTitle")}
          />
          {error ? <p className={styles.keyError}>{t("settings.remoteUnlockError")}</p> : null}
        </div>
        <button type="submit" className={styles.continue} disabled={busy || !key.trim()}>
          {t("settings.remoteUnlockSubmit")}
        </button>
      </form>
    </div>
  );
}
