import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api, type MessageSearchHit } from "../lib/api";
import { useLocale, useT } from "../lib/i18n";
import { formatRelativeActivity } from "./ChatSidebar";
import styles from "./MessageSearchDialog.module.css";

const MIN_QUERY = 2;

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let idx = lower.indexOf(n);
  while (idx >= 0 && parts.length < 40) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={key++}>{text.slice(idx, idx + n.length)}</mark>);
    i = idx + n.length;
    idx = lower.indexOf(n, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return <>{parts}</>;
}

export function MessageSearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setLoading(false);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const s = ++seq.current;
    const timer = window.setTimeout(() => {
      api
        .searchMessages(q)
        .then((h) => {
          if (seq.current !== s) return;
          setHits(h);
          setLoading(false);
        })
        .catch((err) => {
          if (seq.current !== s) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  const needle = query.trim();
  const openHit = (hit: MessageSearchHit) => {
    onClose();
    navigate(
      `/chat?session=${encodeURIComponent(hit.sessionId)}&message=${encodeURIComponent(hit.messageId)}`,
    );
  };
  const nowMs = Date.now();

  return createPortal(
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        aria-label={t("common.cancel")}
        onClick={onClose}
      />
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.searchMessages")}
      >
        <div className={styles.titleBar}>
          <h2 className={styles.title}>{t("chat.searchMessages")}</h2>
          <button
            type="button"
            className={styles.closeBtn}
            aria-label={t("common.cancel")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className={styles.searchRow}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className={styles.searchInput}
            type="text"
            value={query}
            placeholder={t("chat.searchMessagesPlaceholder")}
            aria-label={t("chat.searchMessagesPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
              } else if (e.key === "Enter" && hits.length > 0) {
                e.preventDefault();
                openHit(hits[0]!);
              }
            }}
          />
          {loading ? <span className={styles.spinner} aria-hidden /> : null}
        </div>

        <div className={styles.results} role="listbox" aria-label={t("chat.searchMessages")}>
          {!needle || needle.length < MIN_QUERY ? (
            <p className={styles.empty}>{t("chat.searchMessagesShort")}</p>
          ) : error ? (
            <p className={styles.error}>{error}</p>
          ) : loading ? (
            <p className={styles.empty}>{t("common.loading")}</p>
          ) : hits.length === 0 ? (
            <p className={styles.empty}>{t("chat.searchMessagesEmpty")}</p>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.partId}
                type="button"
                role="option"
                className={styles.hit}
                onClick={() => openHit(hit)}
              >
                <span className={styles.hitTop}>
                  <span className={styles.hitTitle}>{hit.sessionTitle || t("common.newChat")}</span>
                  <span className={styles.hitTime}>
                    {formatRelativeActivity(hit.createdAt, locale, t, nowMs)}
                  </span>
                </span>
                <span className={styles.hitSnippet}>
                  <Highlight text={hit.snippet} needle={needle} />
                </span>
              </button>
            ))
          )}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
