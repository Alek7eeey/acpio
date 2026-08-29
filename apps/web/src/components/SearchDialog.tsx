import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { SessionDto } from "@acpio/shared";
import { api, type MessageSearchHit } from "../lib/api";
import { useLocale, useT } from "../lib/i18n";
import { sessionTreeDisplayTitle } from "../lib/sessionTitle";
import { useAppStore } from "../lib/store";
import { formatRelativeActivity } from "./ChatSidebar";
import styles from "./SearchDialog.module.css";

const MIN_MSG_QUERY = 2;

export type SearchDialogTab = "chats" | "messages";

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

function sortSessions(list: SessionDto[]) {
  return [...list].sort((a, b) => {
    const ta = a.updatedAt ?? a.createdAt;
    const tb = b.updatedAt ?? b.createdAt;
    return tb.localeCompare(ta);
  });
}

export function SearchDialog({
  open,
  onClose,
  initialTab = "chats",
  chatsEnabled = true,
  messagesEnabled = true,
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: SearchDialogTab;
  chatsEnabled?: boolean;
  messagesEnabled?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const sessions = useAppStore((s) => s.sessions);
  const selectSession = useAppStore((s) => s.selectSession);
  const setFocusMessageId = useAppStore((s) => s.setFocusMessageId);

  const [tab, setTab] = useState<SearchDialogTab>(initialTab);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const effectiveTab: SearchDialogTab =
    tab === "chats" && !chatsEnabled ? "messages" : tab === "messages" && !messagesEnabled ? "chats" : tab;

  useEffect(() => {
    if (!open) return;
    const nextTab =
      initialTab === "chats" && !chatsEnabled
        ? "messages"
        : initialTab === "messages" && !messagesEnabled
          ? "chats"
          : initialTab;
    setTab(nextTab);
    setQuery("");
    setHits([]);
    setLoading(false);
    setError(null);
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, initialTab, chatsEnabled, messagesEnabled]);

  const chatNeedle = query.trim().toLowerCase();
  const chatResults = useMemo(() => {
    const list = sortSessions(sessions);
    if (!chatNeedle) return list.slice(0, 24);
    return list
      .filter(
        (s) =>
          s.title.toLowerCase().includes(chatNeedle) ||
          (s.cwd ?? "").toLowerCase().includes(chatNeedle),
      )
      .slice(0, 40);
  }, [sessions, chatNeedle]);

  useEffect(() => {
    if (!open || effectiveTab !== "messages") return;
    const q = query.trim();
    if (q.length < MIN_MSG_QUERY) {
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
  }, [query, open, effectiveTab]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, effectiveTab, chatResults.length, hits.length]);

  if (!open) return null;

  const nowMs = Date.now();
  const msgNeedle = query.trim();
  const resultCount = effectiveTab === "chats" ? chatResults.length : hits.length;

  const openChat = (sessionId: string) => {
    onClose();
    void selectSession(sessionId);
    navigate("/chat");
  };

  const openMessage = (hit: MessageSearchHit) => {
    onClose();
    void selectSession(hit.sessionId).then(() => {
      setFocusMessageId(hit.messageId);
      navigate("/chat");
    });
  };

  const activateAt = (index: number) => {
    if (effectiveTab === "chats") {
      const row = chatResults[index];
      if (row) openChat(row.id);
      return;
    }
    const row = hits[index];
    if (row) openMessage(row);
  };

  const placeholder =
    effectiveTab === "chats"
      ? t("chat.searchChatsPlaceholder")
      : t("chat.searchMessagesPlaceholder");

  return createPortal(
    <div className={styles.overlay}>
      <button type="button" className={styles.backdrop} aria-label={t("common.cancel")} onClick={onClose} />
      <div className={styles.glowA} aria-hidden />
      <div className={styles.glowB} aria-hidden />
      <div className={styles.grid} aria-hidden />
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.searchDialogTitle")}
      >
        <div className={styles.head}>
          <div className={styles.titleWrap}>
            <span className={styles.titleIcon} aria-hidden>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path
                  d="M16 16l4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <div>
              <h2 className={styles.title}>{t("chat.searchDialogTitle")}</h2>
              <p className={styles.subtitle}>{t("chat.searchDialogSubtitle")}</p>
            </div>
          </div>
          <button type="button" className={styles.closeBtn} aria-label={t("common.cancel")} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {chatsEnabled && messagesEnabled ? (
          <div className={styles.tabs} role="tablist" aria-label={t("chat.searchDialogTitle")}>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === "chats"}
              className={`${styles.tab}${effectiveTab === "chats" ? ` ${styles.tabActive}` : ""}`}
              onClick={() => setTab("chats")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 6.5h16M4 11h10M4 15.5h14"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              {t("chat.searchTabChats")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === "messages"}
              className={`${styles.tab}${effectiveTab === "messages" ? ` ${styles.tabActive}` : ""}`}
              onClick={() => setTab("messages")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M7 3.5h10a2 2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H9.5L6 18.4V15H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              {t("chat.searchTabMessages")}
            </button>
          </div>
        ) : null}

        <div className={styles.searchRow}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className={styles.searchInput}
            type="search"
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (resultCount > 0) setActiveIndex((i) => Math.min(resultCount - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (resultCount > 0) setActiveIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && resultCount > 0) {
                e.preventDefault();
                activateAt(activeIndex);
              }
            }}
          />
          {effectiveTab === "messages" && loading ? <span className={styles.spinner} aria-hidden /> : null}
        </div>

        <div className={styles.results} role="listbox" aria-label={placeholder}>
          {effectiveTab === "chats" ? (
            chatResults.length === 0 ? (
              <p className={styles.empty}>
                {chatNeedle ? t("chat.searchEmpty") : t("chat.searchChatsHint")}
              </p>
            ) : (
              chatResults.map((session, index) => (
                <button
                  key={session.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`${styles.hit}${index === activeIndex ? ` ${styles.hitActive}` : ""}`}
                  onClick={() => openChat(session.id)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className={styles.hitTop}>
                    <span className={styles.hitTitle}>
                      <Highlight
                        text={sessionTreeDisplayTitle(session.title, session.provider, t("common.newChat")) || t("common.newChat")}
                        needle={chatNeedle}
                      />
                    </span>
                    <span className={styles.hitMeta}>
                      {formatRelativeActivity(
                        session.updatedAt ?? session.createdAt,
                        locale,
                        t,
                        nowMs,
                      )}
                    </span>
                  </span>
                  {session.cwd ? <span className={styles.hitSub}>{session.cwd}</span> : null}
                </button>
              ))
            )
          ) : !msgNeedle || msgNeedle.length < MIN_MSG_QUERY ? (
            <p className={styles.empty}>{t("chat.searchMessagesShort")}</p>
          ) : error ? (
            <p className={styles.error}>{error}</p>
          ) : loading ? (
            <p className={styles.empty}>{t("common.loading")}</p>
          ) : hits.length === 0 ? (
            <p className={styles.empty}>{t("chat.searchMessagesEmpty")}</p>
          ) : (
            hits.map((hit, index) => (
              <button
                key={hit.partId}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`${styles.hit}${index === activeIndex ? ` ${styles.hitActive}` : ""}`}
                onClick={() => openMessage(hit)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className={styles.hitTop}>
                  <span className={styles.hitTitle}>
                    {sessionTreeDisplayTitle(hit.sessionTitle, undefined, t("common.newChat")) ||
                      t("common.newChat")}
                  </span>
                  <span className={styles.hitMeta}>
                    {formatRelativeActivity(hit.createdAt, locale, t, nowMs)}
                  </span>
                </span>
                <span className={styles.hitSnippet}>
                  <Highlight text={hit.snippet} needle={msgNeedle} />
                </span>
              </button>
            ))
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.hint}>
            <span className={styles.kbd}>↑</span>
            <span className={styles.kbd}>↓</span>
            {t("chat.searchNavigate")}
            <span className={styles.kbd}>↵</span>
            {t("chat.searchOpen")}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
