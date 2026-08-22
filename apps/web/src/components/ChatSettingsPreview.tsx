import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type {
  ChatActionId,
  ChatComposerButtonId,
  ChatHeaderIconId,
  ChatMetaChipId,
  ChatTreeElementId,
  ChatTreeMenuId,
} from "@acprocess/shared";
import { useT } from "../lib/i18n";
import styles from "./ChatSettingsPreview.module.css";

const CHIP_ORDER: ChatMetaChipId[] = ["folder", "thoughts", "mcp", "context"];
const TREE_ORDER: ChatTreeElementId[] = ["search", "searchMsgs", "pin", "archive", "more"];
const COMPOSER_ORDER: ChatComposerButtonId[] = ["attach", "model", "mode", "mic"];
const TREE_MENU_ORDER: ChatTreeMenuId[] = ["rename", "move", "export", "delete"];

/** i18n key for each action's tooltip/label. */
const ACTION_LABEL_KEY: Record<ChatActionId, string> = {
  copy: "common.copy",
  edit: "common.edit",
  like: "common.like",
  dislike: "common.dislike",
  share: "common.share",
  regenerate: "chat.regenerate",
  readAloud: "chat.readAloud",
};

/** i18n key for each optional tree control. */
const TREE_LABEL_KEY: Record<ChatTreeElementId, string> = {
  search: "settings.chatTreeElSearch",
  searchMsgs: "settings.chatTreeElSearchMsgs",
  pin: "settings.chatTreeElPin",
  archive: "settings.chatTreeElArchive",
  more: "settings.chatTreeElMore",
};

/** i18n key for each optional composer button. */
const COMPOSER_LABEL_KEY: Record<ChatComposerButtonId, string> = {
  attach: "settings.chatComposerBtnAttach",
  mic: "settings.chatComposerBtnMic",
  model: "settings.chatComposerBtnModel",
  mode: "settings.chatComposerBtnMode",
};

/** i18n key for each "⋯" context menu command. */
const TREE_MENU_LABEL_KEY: Record<ChatTreeMenuId, string> = {
  rename: "chat.renameSession",
  move: "chat.newInFolder",
  export: "chat.exportChat",
  delete: "common.delete",
};

/** i18n key for each header icon. */
const HEADER_ICON_LABEL_KEY: Record<ChatHeaderIconId, string> = {
  lang: "settings.chatHeaderIconLang",
  install: "settings.chatHeaderIconInstall",
  theme: "settings.chatHeaderIconTheme",
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function actionIcon(id: ChatActionId): ReactNode {
  switch (id) {
    case "copy":
      return (
        <Icon>
          <rect x="8" y="8" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.85" />
          <path
            d="M8 16H6.5A2.5 2.5 0 0 1 4 13.5v-9A2.5 2.5 0 0 1 6.5 2H15.5A2.5 2.5 0 0 1 18 4.5V8"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "edit":
      return (
        <Icon>
          <path
            d="M4 20h4.8L20 8.8 15.2 4 4 15.2V20Z"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
          <path d="M12.8 6.8 17.2 11.2" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
        </Icon>
      );
    case "like":
      return (
        <Icon>
          <path
            d="M7 11v9H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h2Zm0 0 4.2-7.2A2.2 2.2 0 0 1 13.2 3h.3a2 2 0 0 1 2 2.3L14.8 11H20a2 2 0 0 1 2 2.3l-1.1 5.2A3 3 0 0 1 18 21H7"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "dislike":
      return (
        <Icon>
          <path
            d="M17 13V4h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2Zm0 0-4.2 7.2A2.2 2.2 0 0 1 10.8 21h-.3a2 2 0 0 1-2-2.3L9.2 13H4a2 2 0 0 1-2-2.3L3.1 5.5A3 3 0 0 1 6 3h11"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "share":
      return (
        <Icon>
          <path
            d="M12 3v10M12 3l-3.5 3.5M12 3l3.5 3.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "regenerate":
      return (
        <Icon>
          <path
            d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "readAloud":
      return (
        <Icon>
          <path
            d="M11 5 6 9H2v6h4l5 4V5Z"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
          <path
            d="M15.5 8.5a5 5 0 0 1 0 7"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
          />
          <path
            d="M19 5.5a9 9 0 0 1 0 13"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
          />
        </Icon>
      );
  }
}

/**
 * Toggle chip: the element is ALWAYS visible. "accent" variant highlights
 * the active state with the theme accent (message actions, header);
 * "dim" variant only changes opacity (tree, composer). Click toggles.
 */
function El({
  on,
  onToggle,
  label,
  children,
  variant = "accent",
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
  variant?: "accent" | "dim";
}) {
  const state =
    variant === "dim" ? (on ? styles.elDimOn : styles.elDimOff) : on ? styles.elOn : styles.elOff;
  return (
    <span className={`${styles.el} ${state}`} title={label} onClick={onToggle}>
      {children}
    </span>
  );
}

/** Drag-to-resize strip (header height). */
function DragBar({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(0);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const next = Math.round(
        Math.min(max, Math.max(min, startVal.current + (e.clientY - startY.current))),
      );
      onChange(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, min, max, onChange]);

  return (
    <div
      className={`${styles.dragBar}${dragging ? ` ${styles.dragBarActive}` : ""}`}
      title={label}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        startY.current = e.clientY;
        startVal.current = value;
        setDragging(true);
      }}
    >
      <span className={styles.dragGrip} aria-hidden>
        ⋮
      </span>
    </div>
  );
}

/**
 * Message action bar mock: every applicable action renders as a draggable
 * icon in a STABLE slot (position never jumps when toggling). The "⋯"
 * overflow exists only in the real chat — the preview shows all actions.
 *
 * Pointer capture (not HTML5 DnD): nested click-to-toggle chips swallow
 * native dragstart/drop in Chromium, so reorder never fired.
 */
function PreviewActions({
  actions,
  ordered,
  onToggle,
  onReorder,
}: {
  actions: ChatActionId[];
  ordered: ChatActionId[];
  onToggle: (id: ChatActionId) => void;
  onReorder: (dragged: ChatActionId, target: ChatActionId) => void;
}) {
  const t = useT();
  const [overId, setOverId] = useState<ChatActionId | null>(null);
  const [draggingId, setDraggingId] = useState<ChatActionId | null>(null);
  const skipClickRef = useRef(false);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const isOn = (id: ChatActionId) => actions.includes(id);

  const onPointerDown = (id: ChatActionId) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const bar = e.currentTarget.parentElement;
    let moved = false;

    const hit = (x: number, y: number): ChatActionId | null => {
      if (!bar) return null;
      for (const el of bar.querySelectorAll<HTMLElement>("[data-action-id]")) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return el.dataset.actionId as ChatActionId;
        }
      }
      return null;
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        moved = true;
        skipClickRef.current = true;
        setDraggingId(id);
      }
      setOverId(hit(ev.clientX, ev.clientY));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const target = moved ? hit(ev.clientX, ev.clientY) : null;
      setDraggingId(null);
      setOverId(null);
      if (moved && target && target !== id) onReorderRef.current(id, target);
      if (moved) {
        window.setTimeout(() => {
          skipClickRef.current = false;
        }, 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={styles.actions}>
      {ordered.map((id) => (
        <span
          key={id}
          data-action-id={id}
          className={`${styles.dragSlot}${overId === id ? ` ${styles.dragSlotOver}` : ""}${
            draggingId === id ? ` ${styles.dragSlotDragging}` : ""
          }`}
          onPointerDown={onPointerDown(id)}
        >
          <El
            on={isOn(id)}
            onToggle={() => {
              if (skipClickRef.current) return;
              onToggle(id);
            }}
            label={t(ACTION_LABEL_KEY[id] as "common.copy")}
          >
            <span className={styles.actIcon}>{actionIcon(id)}</span>
          </El>
        </span>
      ))}
    </div>
  );
}

/**
 * Interactive full-app mock: header + chat tree + chat thread + composer.
 * Every configurable element is always visible — active elements get the
 * theme accent, inactive ones stay semi-transparent. Click toggles.
 */
export function ChatSettingsPreview({
  actions,
  chips,
  composerButtons,
  treeElements,
  treeMenu,
  showArchive,
  showTime,
  headerHeight,
  headerIcons,
  chatSplit,
  onToggleAction,
  onToggleChip,
  onToggleComposerButton,
  onToggleTreeElement,
  onToggleTreeMenu,
  onToggleShowArchive,
  onReorderAction,
  onHeaderHeight,
  onToggleHeaderIcon,
  onToggleChatSplit,
}: {
  actions: ChatActionId[];
  chips: ChatMetaChipId[];
  composerButtons: ChatComposerButtonId[];
  treeElements: ChatTreeElementId[];
  treeMenu: ChatTreeMenuId[];
  showArchive: boolean;
  showTime: boolean;
  headerHeight: number;
  headerIcons: ChatHeaderIconId[];
  chatSplit: boolean;
  onToggleAction: (id: ChatActionId) => void;
  onToggleChip: (id: ChatMetaChipId) => void;
  onToggleComposerButton: (id: ChatComposerButtonId) => void;
  onToggleTreeElement: (id: ChatTreeElementId) => void;
  onToggleTreeMenu: (id: ChatTreeMenuId) => void;
  onToggleShowArchive: () => void;
  onReorderAction: (nextOrder: ChatActionId[]) => void;
  onHeaderHeight: (next: number) => void;
  onToggleHeaderIcon: (id: ChatHeaderIconId) => void;
  onToggleChatSplit: () => void;
}) {
  const t = useT();
  const mainBarActions = actions.filter((a) => a !== "edit");
  const userBarActions = actions.filter((a) => a === "copy" || a === "edit");
  // User messages can only carry copy/edit; the bot's bar never shows edit.
  const USER_APPLICABLE: ChatActionId[] = ["copy", "edit"];
  const BOT_APPLICABLE: ChatActionId[] = [
    "copy",
    "like",
    "dislike",
    "share",
    "regenerate",
    "readAloud",
  ];
  // Stable display order: initialized from the enabled order + the rest in
  // canonical order; only drag&drop changes it, so toggling never jumps.
  const ALL_ACTIONS: ChatActionId[] = [
    "copy",
    "edit",
    "like",
    "dislike",
    "share",
    "regenerate",
    "readAloud",
  ];
  const [displayOrder, setDisplayOrder] = useState<ChatActionId[]>(() => [
    ...actions,
    ...ALL_ACTIONS.filter((id) => !actions.includes(id)),
  ]);
  const orderedFor = (applicable: ChatActionId[]): ChatActionId[] =>
    applicable
      .filter((id) => displayOrder.includes(id))
      .sort((a, b) => displayOrder.indexOf(a) - displayOrder.indexOf(b));
  const handleReorder = (dragged: ChatActionId, target: ChatActionId) => {
    const from = displayOrder.indexOf(dragged);
    const to = displayOrder.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...displayOrder];
    next.splice(from, 1);
    next.splice(to, 0, dragged);
    setDisplayOrder(next);
    onReorderAction(next);
  };
  const [treeMenuPos, setTreeMenuPos] = useState<{ top: number; left: number } | null>(null);
  const treeMenuRef = useRef<HTMLDivElement>(null);
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  useEffect(() => {
    if (!treeMenuPos) return;
    const onDown = (e: Event) => {
      if (treeMenuRef.current && !treeMenuRef.current.contains(e.target as Node)) {
        setTreeMenuPos(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [treeMenuPos]);
  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const treeOn = (id: ChatTreeElementId) => treeElements.includes(id);
  const btnOn = (id: ChatComposerButtonId) => composerButtons.includes(id);
  const iconOn = (id: ChatHeaderIconId) => headerIcons.includes(id);
  const menuOn = (id: ChatTreeMenuId) => treeMenu.includes(id);

  return (
    <div className={styles.wrap}>
      {/* ── Header (height + icons configurable) ─────────────── */}
      <div className={styles.headerWrap}>
        <div className={styles.header} style={{ height: `${headerHeight}px` }}>
          <span className={styles.brand} aria-hidden>
            {"ACProcess".split("").map((ch, i) => (
              <span key={i} className={i < 3 ? styles.brandMark : undefined}>
                {ch}
              </span>
            ))}
            <span className={styles.brandDivider} aria-hidden />
            <span className={styles.brandChat}>Chat</span>
          </span>
          <span className={styles.headerAgent} aria-hidden>
            <span className={`${styles.dot} ${styles.dotOn}`} aria-hidden />
            <span className={styles.agentModel}>{t("models.auto")}</span>
          </span>
          <span className={styles.headerIcons}>
            <El
              on={iconOn("lang")}
              onToggle={() => onToggleHeaderIcon("lang")}
              label={t("settings.chatHeaderIconLang")}
            >
              <span className={`${styles.headerIcon} ${styles.headerIconLang}`} aria-hidden>
                ru
              </span>
            </El>
            <El
              on={iconOn("install")}
              onToggle={() => onToggleHeaderIcon("install")}
              label={t("settings.chatHeaderIconInstall")}
            >
              <span className={styles.headerIcon} aria-hidden>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 3v10m0 0-3.5-3.5M12 13l3.5-3.5"
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
              </span>
            </El>
            <El
              on={iconOn("theme")}
              onToggle={() => onToggleHeaderIcon("theme")}
              label={t("settings.chatHeaderIconTheme")}
            >
              <span className={styles.headerIcon} aria-hidden>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="4" fill="currentColor" />
                  <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                    <path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.15 5.15l1.4 1.4M17.45 17.45l1.4 1.4M5.15 18.85l1.4-1.4M17.45 6.55l1.4-1.4" />
                  </g>
                </svg>
              </span>
            </El>
            <span className={`${styles.headerIcon} ${styles.headerStatic}`} aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
                <path
                  d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.3.65.85 1.09 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </span>
        </div>
        <DragBar
          label={t("settings.chatHeaderSizeHint")}
          value={headerHeight}
          min={40}
          max={72}
          onChange={onHeaderHeight}
        />
      </div>

      <div className={styles.body}>
        {/* ── Tree ──────────────────────────────────────────────── */}
        {mobileTreeOpen ? (
          <button
            type="button"
            className={styles.treeOverlay}
            onClick={() => setMobileTreeOpen(false)}
            aria-label={t("common.backToChat")}
          />
        ) : null}
        <div className={`${styles.column} ${mobileTreeOpen ? styles.columnOpen : ""}`}>
          <div className={styles.tree}>
            {/* Mandatory: new chat */}
            <span className={styles.treeNewChat} aria-hidden>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5.5 4.8h9.2A3.3 3.3 0 0 1 18 8.1v5.2a3.3 3.3 0 0 1-3.3 3.3H10l-3.4 2.6v-2.6H5.5A3.3 3.3 0 0 1 2.2 13.3V8.1A3.3 3.3 0 0 1 5.5 4.8Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
              {t("common.newChat")}
            </span>

            <div className={styles.treeRowWrap}>
              <El
                on={treeOn("search")} variant="dim"
                onToggle={() => onToggleTreeElement("search")}
                label={t("settings.chatTreeElSearch")}
              >
                <span className={styles.treeSearch} aria-hidden>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  {t("settings.chatTreeElSearch")}
                </span>
              </El>
              <El
                on={treeOn("searchMsgs")} variant="dim"
                onToggle={() => onToggleTreeElement("searchMsgs")}
                label={t("settings.chatTreeElSearchMsgs")}
              >
                <span className={styles.treeSearchMsgs} aria-hidden>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </span>
              </El>
            </div>

            <div className={styles.treeFolder}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v1"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M3.5 10.2h17v6.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-6.3Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
              <span className={styles.treeFolderLabel}>E:\share\acprocess</span>
              {/* Mandatory: folder add */}
              <span className={styles.treeAdd} aria-hidden>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                </svg>
              </span>
            </div>

            {[
              { title: "Деплой ACProcess на прод", busy: true },
              { title: "Рефакторинг поиска сообщений", busy: false },
            ].map((row, i) => (
              <div
                key={row.title}
                className={`${styles.treeRow}${i === 0 ? ` ${styles.treeRowActive}` : ""}`}
              >
                <span className={styles.treeRowTitle}>
                  {row.title}
                  
                </span>
                <El
                  on={treeOn("pin")} variant="dim"
                  onToggle={() => onToggleTreeElement("pin")}
                  label={t("settings.chatTreeElPin")}
                >
                  <span className={styles.treeAct} aria-hidden>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M9.2 4h5.6l.6 4.8 2.6 2.2v2.6H6v-2.6l2.6-2.2.6-4.8Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                      <path d="M12 13.6V20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </span>
                </El>
                <El
                  on={treeOn("archive")} variant="dim"
                  onToggle={() => onToggleTreeElement("archive")}
                  label={t("settings.chatTreeElArchive")}
                >
                  <span className={styles.treeAct} aria-hidden>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                      <path d="M4.5 7.5V5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v2" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </span>
                </El>
                {treeMenu.length > 0 ? (
                  <span
                    className={styles.treeAct}
                    aria-hidden
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setTreeMenuPos({ top: r.bottom + 4, left: r.left });
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="5" cy="12" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="19" cy="12" r="1.5" />
                    </svg>
                  </span>
                ) : null}
              </div>
            ))}

            <El
              on={showArchive} variant="dim"
              onToggle={onToggleShowArchive}
              label={t("settings.chatTreeElArchive")}
            >
              <span className={styles.treeArchiveHead} aria-hidden>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path d="M4.5 7.5V5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v2" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                {t("chat.archiveSection")}
                <span className={styles.treeArchiveCount}>2</span>
              </span>
            </El>
          </div>
        </div>

        {treeMenuPos ? (
          <div
            ref={treeMenuRef}
            className={styles.treeMenuPop}
            role="menu"
            style={{ top: treeMenuPos.top, left: treeMenuPos.left }}
          >
            {TREE_MENU_ORDER.map((id) => (
              <El
                key={id}
                variant="dim"
                on={menuOn(id)}
                onToggle={() => onToggleTreeMenu(id)}
                label={t(TREE_MENU_LABEL_KEY[id] as "common.delete")}
              >
                <span className={styles.treeMenuItem}>
                  {t(TREE_MENU_LABEL_KEY[id] as "common.delete")}
                </span>
              </El>
            ))}
          </div>
        ) : null}

        {/* ── Chat ──────────────────────────────────────────────── */}
        <div className={`${styles.column} ${styles.chatColumn}`}>
          <span className={styles.previewSplitSlot}>
          <El
            on={chatSplit}
            onToggle={onToggleChatSplit}
            label={t("settings.chatSplit")}
          >
            <span className={styles.previewSplitFab} aria-hidden>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <rect x="3.75" y="5.5" width="7" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
                <rect
                  x="13.25"
                  y="5.5"
                  width="7"
                  height="13"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  opacity="0.55"
                />
              </svg>
            </span>
          </El>
          </span>
          <button
            type="button"
            className={styles.mobileTreeBtn}
            onClick={() => setMobileTreeOpen((v) => !v)}
          >
            {mobileTreeOpen ? "✕" : "☰"}
          </button>
          <div className={styles.chatPane}>
            <div className={styles.thread}>
              <div className={styles.threadInner}>
              <div className={`${styles.msgRow} ${styles.userMsg}`}>
                <div className={styles.userBubble}>
                  {t("chatPreviewUser")}
                  {showTime ? <span className={styles.time}>{now}</span> : null}
                </div>
              </div>
              <div className={`${styles.msgRow} ${styles.userActionsRow}`}>
                <PreviewActions
                  actions={userBarActions}
                  ordered={orderedFor(USER_APPLICABLE)}
                  onToggle={onToggleAction}
                  onReorder={handleReorder}
                />
              </div>

              <div className={`${styles.msgRow} ${styles.assistantMsg}`}>
                <div className={styles.assistantCol}>
                  <div className={styles.assistantText}>
                    {t("chatPreviewAssistant")}
                    {showTime ? <span className={styles.time}>{now}</span> : null}
                  </div>
                  <div className={styles.thought} aria-hidden>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                      />
                    </svg>
                    <span>{t("chatPreviewThought")}</span>
                  </div>
                  <div className={styles.toolRow} aria-hidden>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v1"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M3.5 10.2h17v6.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-6.3Z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>{t("chatPreviewTool")}</span>
                    <svg className={styles.toolCheck} width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div className={styles.typing} aria-hidden>
                    <span />
                    <span />
                    <span />
                  </div>
                  <PreviewActions
                    actions={mainBarActions}
                    ordered={orderedFor(BOT_APPLICABLE)}
                    onToggle={onToggleAction}
                    onReorder={handleReorder}
                  />
                </div>
              </div>
              </div>
            </div>

            <div className={styles.composer}>
              <div className={styles.composerTopRow}>
                <div className={styles.chips}>
                  {CHIP_ORDER.map((id) => (
                    <El
                      key={id}
                      on={chips.includes(id)} variant="dim"
                      onToggle={() => onToggleChip(id)}
                      label={
                        id === "folder"
                          ? t("settings.chatMetaChipFolder")
                          : id === "thoughts"
                            ? t("settings.chatMetaChipThoughts")
                            : id === "context"
                              ? t("settings.chatMetaChipContext")
                              : t("settings.chatMetaChipMcp")
                      }
                    >
                      <span className={styles.chip} aria-hidden>
                        {id === "folder" ? t("settings.chatMetaChipFolder") : null}
                        {id === "thoughts" ? t("settings.chatMetaChipThoughts") : null}
                        {id === "mcp" ? t("settings.chatMetaChipMcp") : null}
                        {id === "context" ? t("settings.chatMetaChipContext") : null}
                      </span>
                    </El>
                  ))}
                </div>
                <El
                  on={btnOn("mode")}
                  variant="dim"
                  onToggle={() => onToggleComposerButton("mode")}
                  label={t("settings.chatComposerBtnMode")}
                >
                  <span className={styles.composerChip} aria-hidden>
                    {t("modes.agent")}
                  </span>
                </El>
              </div>
              <div className={styles.pill}>
                <El
                  on={btnOn("attach")} variant="dim"
                  onToggle={() => onToggleComposerButton("attach")}
                  label={t("settings.chatComposerBtnAttach")}
                >
                  <span className={styles.composerBtn} aria-hidden>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </El>
                <span className={styles.inputMock}>{t("common.messageOrCommand")}</span>
                <El
                  on={btnOn("model")} variant="dim"
                  onToggle={() => onToggleComposerButton("model")}
                  label={t("settings.chatComposerBtnModel")}
                >
                  <span className={styles.composerChip} aria-hidden>
                    {t("models.auto")}
                  </span>
                </El>
                <El
                  on={btnOn("mic")} variant="dim"
                  onToggle={() => onToggleComposerButton("mic")}
                  label={t("settings.chatComposerBtnMic")}
                >
                  <span className={`${styles.composerBtn} ${styles.composerBtnRound}`} aria-hidden>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
                      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  </span>
                </El>
                <span className={styles.sendMock} aria-hidden>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 19V5M12 5l-6 6M12 5l6 6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
