import type { ChatNoticeLine, MessageDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import styles from "./SettingsNotice.module.css";

/**
 * Display lines of a chat's settings notice.
 *
 * The payload is stored JSON, so anything that is not a well-formed line is
 * dropped instead of rendered as `undefined → undefined`.
 */
export function settingsNoticeLines(message: MessageDto): ChatNoticeLine[] {
  const out: ChatNoticeLine[] = [];
  const parts = [...message.parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const part of parts) {
    if (part.type !== "notice") continue;
    const raw = part.payload?.lines;
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      const row = (item ?? {}) as Record<string, unknown>;
      const from = String(row.from ?? "").trim();
      const to = String(row.to ?? "").trim();
      if (!from || !to) continue;
      if (row.kind === "param") {
        out.push({ kind: "param", label: String(row.label ?? "").trim(), from, to });
      } else {
        out.push({ kind: "model", from, to });
      }
    }
  }
  return out;
}

/**
 * A switch made in the composer, written into the transcript where it happened:
 * `старая модель → новая` and one row per config option that moved with it.
 *
 * It is its own message with role `system` — the change belongs to neither the
 * turn above nor the one below it — and it only ever appears in a chat that
 * already has messages (see `setSessionModel` on the server).
 */
export function SettingsNotice({ message }: { message: MessageDto }) {
  const t = useT();
  const lines = settingsNoticeLines(message);
  if (!lines.length) return null;
  return (
    <div className={styles.notice} data-notice-id={message.id}>
      <span className={styles.icon} aria-hidden>
        ⇄
      </span>
      <span className={styles.lines}>
        {lines.map((line, index) => {
          const label = line.kind === "model" ? t("chat.modelNoticeModel") : line.label;
          return (
            <span className={styles.line} key={`${line.kind}-${index}`}>
              {label ? <span className={styles.label}>{label}</span> : null}
              <span className={styles.value}>{line.from}</span>
              <span className={styles.arrow} aria-hidden>
                →
              </span>
              <span className={`${styles.value} ${styles.to}`}>{line.to}</span>
            </span>
          );
        })}
      </span>
    </div>
  );
}
