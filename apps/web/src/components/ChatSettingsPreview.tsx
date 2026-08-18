import { useState, type ReactNode } from "react";
import type { ChatActionId, ChatMetaChipId, ChatTreeElementId } from "@acprocess/shared";
import { useT } from "../lib/i18n";
import styles from "./ChatSettingsPreview.module.css";

const CHIP_ORDER: ChatMetaChipId[] = ["folder", "thoughts", "mcp"];
const TREE_ORDER: ChatTreeElementId[] = [
  "newChat",
  "search",
  "searchMsgs",
  "folderAdd",
  "pin",
  "archive",
  "more",
];

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

/** i18n key for each tree control. */
const TREE_LABEL_KEY: Record<ChatTreeElementId, string> = {
  newChat: "settings.chatTreeElNewChat",
  search: "settings.chatTreeElSearch",
  searchMsgs: "settings.chatTreeElSearchMsgs",
  folderAdd: "settings.chatTreeElFolderAdd",
  pin: "settings.chatTreeElPin",
  archive: "settings.chatTreeElArchive",
  more: "settings.chatTreeElMore",
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

/**
 * Click-to-toggle wrapper: when the element is enabled it renders as-is
 * (clicking hides it); when disabled it becomes a small "+ label" button.
 */
function T({
  on,
  onToggle,
  addLabel,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  addLabel: string;
  children: ReactNode;
}) {
  if (on) {
    return (
      <span className={styles.live} title={addLabel} onClick={onToggle}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" className={styles.addBtn} onClick={onToggle} title={addLabel}>
      + {addLabel}
    </button>
  );
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
 * Interactive full-app mock: header + chat tree + chat thread + composer.
 * Every control is clickable — click an element to hide it, click its
 * "+ label" slot to bring it back. Mirrors the real chat exactly.
 */
export function ChatSettingsPreview({
  actions,
  chips,
  treeElements,
  readAloud,
  voiceInput,
  showTime,
  toolbarSize,
  headerSize,
  onToggleAction,
  onToggleChip,
  onToggleTreeElement,
}: {
  actions: ChatActionId[];
  chips: ChatMetaChipId[];
  treeElements: ChatTreeElementId[];
  readAloud: boolean;
  voiceInput: boolean;
  showTime: boolean;
  toolbarSize: "compact" | "default" | "roomy";
  headerSize: "compact" | "default" | "roomy";
  onToggleAction: (id: ChatActionId) => void;
  onToggleChip: (id: ChatMetaChipId) => void;
  onToggleTreeElement: (id: ChatTreeElementId) => void;
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
  const headerClass =
    headerSize === "compact"
      ? styles.headerCompact
      : headerSize === "roomy"
        ? styles.headerRoomy
        : "";
  const treeOn = (id: ChatTreeElementId) => treeElements.includes(id);

  return (
    <div className={styles.wrap}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className={styles.sectionLabel}>{t("settings.chatPreviewHeader")}</div>
      <div className={`${styles.header} ${headerClass}`}>
        <span className={styles.brand} aria-hidden>
          <span className={styles.brandMark}>AC</span>Process <span className={styles.brandChat}>Chat</span>
        </span>
        <span className={styles.headerAgent} aria-hidden>
          <span className={styles.avatar} aria-hidden>
            A
          </span>
          OMP · {t("common.online")}
        </span>
        <span className={styles.headerIcons} aria-hidden>
          <span className={styles.headerIcon} />
          <span className={styles.headerIcon} />
          <span className={styles.headerIcon} />
        </span>
      </div>

      <div className={styles.body}>
        {/* ── Tree ──────────────────────────────────────────────── */}
        <div className={styles.column}>
          <div className={styles.sectionLabel}>{t("settings.chatPreviewTree")}</div>
          <div className={styles.tree}>
            <div className={styles.treeTop}>
              <T
                on={treeOn("newChat")}
                onToggle={() => onToggleTreeElement("newChat")}
                addLabel={t("settings.chatTreeElNewChat")}
              >
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
              </T>
              <T
                on={treeOn("search")}
                onToggle={() => onToggleTreeElement("search")}
                addLabel={t("settings.chatTreeElSearch")}
              >
                <span className={styles.treeSearch} aria-hidden>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  {t("settings.chatTreeElSearch")}
                </span>
              </T>
              <T
                on={treeOn("searchMsgs")}
                onToggle={() => onToggleTreeElement("searchMsgs")}
                addLabel={t("settings.chatTreeElSearchMsgs")}
              >
                <span className={styles.treeSearchMsgs} aria-hidden>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M7 3h10a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 17 16h-7.5l-3.5 3.4v-3.4H7A2.5 2.5 0 0 1 4.5 13.5v-8A2.5 2.5 0 0 1 7 3Z"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                    <circle cx="16.3" cy="15.7" r="2.7" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </span>
              </T>
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
              <T
                on={treeOn("folderAdd")}
                onToggle={() => onToggleTreeElement("folderAdd")}
                addLabel={t("settings.chatTreeElFolderAdd")}
              >
                <span className={styles.treeAdd} aria-hidden>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  </svg>
                </span>
              </T>
            </div>

            {[
              { title: "Деплой ACProcess на прод", busy: true },
              { title: "Рефакторинг поиска сообщений", busy: false },
            ].map((row) => (
              <div key={row.title} className={styles.treeRow}>
                <span className={styles.treeRowTitle}>
                  {row.title}
                  {row.busy ? <span className={styles.treeBusy} aria-hidden /> : null}
                </span>
                <T
                  on={treeOn("pin")}
                  onToggle={() => onToggleTreeElement("pin")}
                  addLabel={t("settings.chatTreeElPin")}
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
                </T>
                <T
                  on={treeOn("archive")}
                  onToggle={() => onToggleTreeElement("archive")}
                  addLabel={t("settings.chatTreeElArchive")}
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
                </T>
                <T
                  on={treeOn("more")}
                  onToggle={() => onToggleTreeElement("more")}
                  addLabel={t("settings.chatTreeElMore")}
                >
                  <span className={styles.treeAct} aria-hidden>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="5" cy="12" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="19" cy="12" r="1.5" />
                    </svg>
                  </span>
                </T>
              </div>
            ))}
          </div>
        </div>

        {/* ── Chat ──────────────────────────────────────────────── */}
        <div className={styles.column}>
          <div className={styles.sectionLabel}>{t("settings.chatPreviewChat")}</div>
          <div className={styles.chatPane}>
            <div className={styles.chatHead}>
              <strong>{t("settings.chatPreviewChatTitle")}</strong>
              <span className={styles.chatHeadChip}>Deepseek V4 Flash</span>
              <span className={styles.chatHeadMode}>{t("modes.agent")}</span>
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
        </div>
      </div>
    </div>
  );
}
