import { useState, type ReactNode } from "react";
import type { ChatActionId, ChatMetaChipId } from "@acprocess/shared";
import { useT } from "../lib/i18n";
import styles from "./ChatSettingsPreview.module.css";

const CHIP_ORDER: ChatMetaChipId[] = ["folder", "thoughts", "mcp"];

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
            d="M4 9v6h3l5 4V5L7 9H4Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M16 8.5a4.5 4.5 0 0 1 0 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </Icon>
      );
  }
}

function ActionIconButton({ id, onClick }: { id: ChatActionId; onClick: () => void }) {
  const t = useT();
  const label = t(ACTION_LABEL_KEY[id] as "common.copy");
  return (
    <button type="button" className={styles.actBtn} title={label} aria-label={label} onClick={onClick}>
      {actionIcon(id)}
    </button>
  );
}

/** Message action bar mock with the real 5-icons + "⋯" overflow rule. */
function PreviewActions({
  actions,
  onToggle,
}: {
  actions: ChatActionId[];
  onToggle: (id: ChatActionId) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const icons = actions.slice(0, 5);
  const overflow = actions.slice(5);
  if (actions.length === 0) return null;
  return (
    <div className={styles.actions}>
      {icons.map((id) => (
        <ActionIconButton key={id} id={id} onClick={() => onToggle(id)} />
      ))}
      {overflow.length > 0 ? (
        <>
          <button
            type="button"
            className={styles.actBtn}
            title={t("common.more")}
            aria-label={t("common.more")}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon>
              <circle cx="5" cy="12" r="1.7" fill="currentColor" />
              <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              <circle cx="19" cy="12" r="1.7" fill="currentColor" />
            </Icon>
          </button>
          {open ? (
            <div className={styles.overflow} role="menu">
              {overflow.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  className={styles.overflowItem}
                  onClick={() => {
                    setOpen(false);
                    onToggle(id);
                  }}
                >
                  {actionIcon(id)}
                  <span>{t(ACTION_LABEL_KEY[id] as "common.copy")}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Interactive chat mock: a realistic miniature chat (avatars, thinking block,
 * tool row, typing indicator) that mirrors the configured message actions,
 * composer chips and flags. Clicking actions/chips toggles them live.
 */
export function ChatSettingsPreview({
  actions,
  chips,
  readAloud,
  voiceInput,
  showTime,
  toolbarSize,
  onToggleAction,
  onToggleChip,
}: {
  actions: ChatActionId[];
  chips: ChatMetaChipId[];
  readAloud: boolean;
  voiceInput: boolean;
  showTime: boolean;
  toolbarSize: "compact" | "default" | "roomy";
  onToggleAction: (id: ChatActionId) => void;
  onToggleChip: (id: ChatMetaChipId) => void;
}) {
  const t = useT();
  const mainBarActions = actions.filter((a) => a !== "edit" && (a !== "readAloud" || readAloud));
  const userBarActions = actions.filter((a) => a === "copy" || a === "edit");
  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sizeClass =
    toolbarSize === "compact"
      ? styles.composerCompact
      : toolbarSize === "roomy"
        ? styles.composerRoomy
        : "";

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <span className={styles.avatar} aria-hidden>
          A
        </span>
        <div className={styles.headerMeta}>
          <strong>ACProcess</strong>
          <span>Deepseek V4 Flash · {t("settings.chatPreview")}</span>
        </div>
      </div>

      <div className={styles.thread}>
        <div className={styles.msgRow}>
          <div className={`${styles.bubble} ${styles.userBubble}`}>
            {t("chatPreviewUser")}
            {showTime ? <span className={styles.time}>{now}</span> : null}
          </div>
        </div>
        {userBarActions.length > 0 ? (
          <div className={styles.msgRow}>
            <PreviewActions actions={userBarActions} onToggle={onToggleAction} />
          </div>
        ) : null}

        <div className={styles.msgRow}>
          <span className={`${styles.avatar} ${styles.assistantAvatar}`} aria-hidden>
            A
          </span>
          <div className={styles.assistantCol}>
            <div className={`${styles.bubble} ${styles.assistantBubble}`}>
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
            <PreviewActions actions={mainBarActions} onToggle={onToggleAction} />
          </div>
        </div>
      </div>

      <div className={`${styles.composer} ${sizeClass}`}>
        <div className={styles.chips}>
          {CHIP_ORDER.filter((id) => chips.includes(id)).map((id) => (
            <button
              key={id}
              type="button"
              className={styles.chip}
              aria-pressed
              onClick={() => onToggleChip(id)}
            >
              {id === "folder" ? t("settings.chatMetaChipFolder") : null}
              {id === "thoughts" ? t("settings.chatMetaChipThoughts") : null}
              {id === "mcp" ? t("settings.chatMetaChipMcp") : null}
            </button>
          ))}
        </div>
        <div className={styles.inputRow}>
          <span className={styles.inputMock}>{t("common.messageOrCommand")}</span>
          {voiceInput ? (
            <span className={styles.inputIcon} title={t("chat.voiceInput")} aria-hidden>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M5 11a7 7 0 0 0 14 0M12 18v3"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          ) : null}
          <span className={styles.sendMock} aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 12 20 4l-4 8 4 8-16-8Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
