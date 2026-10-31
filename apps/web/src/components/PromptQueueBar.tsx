import { useState } from "react";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import styles from "./PromptQueueBar.module.css";

/** What the bar needs of a queued request — the store's item is wider. */
type QueueItem = { id: string; text: string };

/** How far a press must travel before the grip starts a reorder. */
const DRAG_THRESHOLD_PX = 6;

/**
 * The requests queued while the agent was busy: each one is its own row, and
 * every row is editable, deletable and movable *before* the queue hands it
 * over — the queue is the delivery order, so the order here is the order the
 * agent gets them in. The single arrow is «send now»: stop the live step and
 * hand this request over at once.
 *
 * The pencil does not open a field of its own: the row hands its text to the
 * chat's composer (`onEdit`), which is where the reader writes — one editor for
 * the message they are sending and the request they are still shaping.
 */
export function PromptQueueBar({
  items,
  onEdit,
  editingId = null,
}: {
  items: ReadonlyArray<QueueItem>;
  onEdit: (item: QueueItem) => void;
  /** The row whose text the composer is holding right now. */
  editingId?: string | null;
}) {
  const t = useT();
  const deliverQueuedPrompt = useAppStore((s) => s.deliverQueuedPrompt);
  const removeQueuedPrompt = useAppStore((s) => s.removeQueuedPrompt);
  const reorderQueuedPrompt = useAppStore((s) => s.reorderQueuedPrompt);

  /** The row being dragged, the row it is over and which side of it. */
  const [drag, setDrag] = useState<{
    id: string;
    overId: string | null;
    position: "before" | "after";
  } | null>(null);

  /** The row under the point — the reorder resolves against what is on screen. */
  const itemAtPoint = (x: number, y: number) => {
    for (const node of document.elementsFromPoint(x, y)) {
      const row = (node as Element).closest?.("[data-queue-id]") as HTMLElement | null;
      if (row) return { id: row.getAttribute("data-queue-id") ?? "", el: row };
    }
    return null;
  };

  const startDrag = (id: string) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // The grip is not a text field: a press on it must not select the row.
    e.preventDefault();
    const pointerId = e.pointerId;
    const startY = e.clientY;
    let moved = false;
    let overId: string | null = null;
    let position: "before" | "after" = "after";

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDrag(null);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        moved = true;
      }
      const hit = itemAtPoint(ev.clientX, ev.clientY);
      if (hit && hit.id !== id) {
        const rect = hit.el.getBoundingClientRect();
        position = ev.clientY < rect.top + rect.height / 2 ? "before" : "after";
        overId = hit.id;
        setDrag({ id, overId, position });
      } else {
        overId = null;
        setDrag({ id, overId: null, position });
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const target = overId;
      const side = position;
      finish();
      if (!moved || !target) return;
      reorderQueuedPrompt(id, target, side);
    };

    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      finish();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  return (
    <div className={styles.queueBar} data-prompt-queue="">
      <div className={styles.queueBarHeader}>
        <span className={styles.queueBarTitle}>{t("chat.promptQueue")}</span>
        <span className={styles.queueBarCount}>
          {t("chat.queueCount", { count: items.length })}
        </span>
      </div>
      <div className={styles.queueList}>
        {items.map((item) => {
          const dropHint = drag?.overId === item.id ? drag.position : null;
          const editing = editingId === item.id;
          return (
            <div
              key={item.id}
              data-queue-id={item.id}
              className={`${styles.queueItem}${
                drag?.id === item.id ? ` ${styles.queueItemDragging}` : ""
              }${dropHint === "before" ? ` ${styles.queueItemBefore}` : ""}${
                dropHint === "after" ? ` ${styles.queueItemAfter}` : ""
              }${editing ? ` ${styles.queueItemEditing}` : ""}`}
            >
              <button
                type="button"
                className={`${styles.queueItemBtn} ${styles.queueGrip}`}
                title={t("chat.queueReorder")}
                aria-label={t("chat.queueReorder")}
                onPointerDown={startDrag(item.id)}
              >
                <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
                  <circle cx="2.5" cy="2.5" r="1.2" />
                  <circle cx="7.5" cy="2.5" r="1.2" />
                  <circle cx="2.5" cy="7" r="1.2" />
                  <circle cx="7.5" cy="7" r="1.2" />
                  <circle cx="2.5" cy="11.5" r="1.2" />
                  <circle cx="7.5" cy="11.5" r="1.2" />
                </svg>
              </button>
              <span
                className={styles.queueItemText}
                title={item.text}
                onDoubleClick={() => onEdit(item)}
              >
                {item.text}
              </span>
              <button
                type="button"
                className={styles.queueItemBtn}
                title={t("common.edit")}
                aria-label={t("common.edit")}
                aria-pressed={editing}
                onClick={() => onEdit(item)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4.5 19.5h15M6 15.5l9.6-9.6a1.7 1.7 0 0 1 2.4 2.4L8.4 18H6v-2.5Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={styles.queueItemBtn}
                title={t("common.delete")}
                aria-label={t("common.delete")}
                onClick={() => removeQueuedPrompt(item.id)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M6 6l12 12M18 6 6 18"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={`${styles.queueItemBtn} ${styles.queueItemBtnSend}`}
                title={t("chat.queueDeliverySteer")}
                aria-label={t("chat.queueDeliverySteer")}
                onClick={() => void deliverQueuedPrompt(item.id, "steer")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M12 19V5M12 5l-6 6M12 5l6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
