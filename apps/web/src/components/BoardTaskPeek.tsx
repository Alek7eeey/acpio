import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessageDto, SessionDto } from "@acpio/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { messagePlainText } from "../lib/messageText";
import styles from "./BoardTaskPeek.module.css";

/** How much of a chat the peek shows: the last turns, not the whole log. */
const PEEK_MESSAGES = 8;

/** i18n key of each role's label in the peek — the exporter's own names. */
const ROLE_LABEL_KEY = {
  user: "export.user",
  assistant: "export.assistant",
  system: "export.system",
} as const;

/**
 * A task's chat, read without leaving the board: a small floating peek hung by
 * the place the card's menu was opened from, holding the last turns of the
 * dialogue. It reads the chat over the same door the chat page does — nothing
 * is selected, so the board stays where it is — and goes away on Escape, on a
 * press outside it, or through its own "go to chat", which opens the task.
 */
export function BoardTaskPeek({
  task,
  anchor,
  onOpen,
  onClose,
}: {
  task: SessionDto;
  /** Where the card's menu stood: the peek hangs there, clamped into view. */
  anchor: { x: number; y: number };
  onOpen: () => void;
  onClose: () => void;
}) {
  const t = useT();
  /** Null while the chat is on its way; the failed flag replaces it. */
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let dropped = false;
    setMessages(null);
    setFailed(false);
    api.getSession(task.id).then(
      (detail) => {
        if (!dropped) setMessages(detail.messages);
      },
      () => {
        if (!dropped) setFailed(true);
      },
    );
    return () => {
      dropped = true;
    };
  }, [task.id]);

  // A chat reads bottom-up: the peek opens on the last turn, and only the
  // turns that carry text are shown — a tool call is nothing to read here.
  const turns = (messages ?? [])
    .map((message) => ({ message, text: messagePlainText(message) }))
    .filter((entry) => entry.text)
    .slice(-PEEK_MESSAGES);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Measure → clamp into the viewport, before paint (no wrong-spot flash).
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const x = Math.min(
      Math.max(12, anchor.x),
      Math.max(12, window.innerWidth - width - 12),
    );
    const y = Math.min(
      Math.max(12, anchor.y),
      Math.max(12, window.innerHeight - height - 12),
    );
    setPos((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
  });

  // Escape and a press outside dismiss it, exactly like the card's own menu.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={boxRef}
      className={styles.peek}
      role="dialog"
      aria-label={t("chat.boardPeekCard")}
      data-task-id={task.id}
      style={{
        left: pos?.x ?? anchor.x,
        top: pos?.y ?? anchor.y,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className={styles.head}>
        <span className={styles.title} title={task.title}>
          {task.title}
        </span>
        <button
          type="button"
          className={styles.close}
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div ref={bodyRef} className={styles.body}>
        {failed ? (
          <p className={styles.note}>{t("chat.boardPeekFailed")}</p>
        ) : messages === null ? (
          <p className={styles.note}>{t("common.loading")}</p>
        ) : turns.length === 0 ? (
          <p className={styles.note}>{t("chat.boardPeekEmpty")}</p>
        ) : (
          turns.map(({ message, text }) => (
            <div key={message.id} className={styles.turn} data-role={message.role}>
              <span className={styles.role}>{t(ROLE_LABEL_KEY[message.role])}</span>
              <p className={styles.text}>{text}</p>
            </div>
          ))
        )}
      </div>
      <div className={styles.foot}>
        <button type="button" className={styles.open} onClick={onOpen}>
          {t("common.goToChat")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
