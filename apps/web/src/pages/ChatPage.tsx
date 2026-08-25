import { Link, useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  type CSSProperties,
  type RefObject,

} from "react";
import {
  isPlaceholderSubagentTitle,
  isSubagentToolCall,
  migrateModelParamValues,
  toolDisplayTitle,
  estimateContextUsage,
  modelForProvider,
  modelForSession,
  modelParamsForSession,
  type AgentMode,
  type MessageDto,
  type MessagePartDto,
  type ModelParamDto,
  type SessionDetailDto,
  type SlashCommandDto,
} from "@acprocess/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useBrowserLocation } from "../lib/usePathname";
import { CHAT_SPLIT_MIN_PX, FALLBACK_CHAT_PANES } from "../lib/chatPanes";
import { sanitizeCatalogModes, selectLiveSessionDetail, useAppStore, type PendingAttachment } from "../lib/store";
import { AttachDialog } from "../components/AttachDialog";
import { McpChatDialog } from "../components/McpChatDialog";
import { submitDiagnosticsDump } from "../lib/diagnostics";
import {
  dominantLanguage,
  startReadAloud,
  stopReadAloud,
  stripMarkdownForSpeech,
} from "../lib/tts";
import { removeLikedMessage, saveLikedMessage } from "../lib/likedMessages";
import { AppDialog } from "../components/AppDialog";
import { ModelPicker } from "../components/ModelPicker";
import { HoverTip } from "../components/HoverTip";
import { ChatInlinePrompt } from "../components/ChatInlinePrompt";
import { PlanSidePanel, PlanTabButton } from "../components/PlanSidePanel";
import { ConsoleSidePanel } from "../components/ConsoleSidePanel";
import { ComposerMetaChips } from "../components/ComposerMetaChips";
import { coercePlanPayload, type PlanPayload } from "../components/PlanApprovalBody";
import { OptionPicker } from "../components/OptionPicker";
import {
  collectRecentCwds,
  CreateSessionFolderPicker,
} from "../components/CreateSessionFolderPicker";
import { MarkdownContent } from "../components/MarkdownContent";
import { SlashCommandMenu } from "../components/SlashCommandMenu";
import { notifyTurnComplete, requestNotificationPermission } from "../lib/notify";
import { isImageFile } from "../lib/pathSegments";
import {
  prefersHotkeyHints,
  registerMessageHotkeys,

  setMessageHotkeyHover,
  subscribeHotkeyHintPreference,
  updateMessageHotkeys,
  type MessageHotAction,
} from "../lib/messageHotkeys";
import { isTouchUi } from "../lib/pointerUi";
import { showToast } from "../lib/toast";
import {
  buildSlashInsertion,
  filterSlashCommands,
  getSlashContext,
  isSlashCommandReadyToSend,
  mergeSlashCommands,
  parseSlashCommandText,
  slashCommandRequiresInput,
  splitSlashCommandHighlight,
} from "../lib/slashCommands";
import { slashListStillLoading } from "../lib/sessionSlashCommands";
import styles from "./ChatPage.module.css";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Split text into text and link segments, making URLs clickable. */
function renderThoughtText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const url = match[0];
    parts.push(
      <span
        key={match.index}
        role="link"
        tabIndex={0}
        style={{ color: "var(--accent)", textDecoration: "underline", cursor: "pointer", textUnderlineOffset: "2px" }}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(url, "_blank", "noopener,noreferrer"); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); window.open(url, "_blank", "noopener,noreferrer"); } }}
      >
        {url}
      </span>,
    );
    lastIdx = match.index + url.length;
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts;
}

/** Desktop-only: avoid popping the mobile keyboard during stream / scroll updates. */
function shouldAutoFocusComposer() {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(pointer: fine)").matches;
}

const MSG_RATING_KEY = "acprocess.msgRating.v1";
type MsgRating = "like" | "dislike";

type SpeechRecognitionResultItem = { transcript: string };
type SpeechRecognitionResult = {
  isFinal: boolean;
  0: SpeechRecognitionResultItem;
};
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

function readMessageRating(messageId: string): MsgRating | null {
  try {
    const raw = localStorage.getItem(MSG_RATING_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, MsgRating>;
    return map[messageId] ?? null;
  } catch {
    return null;
  }
}

function writeMessageRating(messageId: string, rating: MsgRating | null) {
  try {
    const raw = localStorage.getItem(MSG_RATING_KEY);
    const map: Record<string, MsgRating> = raw ? JSON.parse(raw) : {};
    if (rating === null) delete map[messageId];
    else map[messageId] = rating;
    localStorage.setItem(MSG_RATING_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/** Plain text of a message (text parts only) — shared by render + actions. */
function messagePlainText(message: MessageDto): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload.text ?? ""))
    .join("\n")
    .trim();
}

type MessageCtxHandle = {
  openAt: (x: number, y: number) => void;
};

function readDomSelection(): string {
  const value = window.getSelection()?.toString() ?? "";
  return value.trim() ? value : "";
}

async function copyTextToClipboard(value: string) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
}

function selectionInsideMessage(messageId: string): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const node = sel.anchorNode;
  if (!node) return false;
  const el = node instanceof Element ? node : node.parentElement;
  const safeId = messageId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return Boolean(el?.closest(`[data-msg-hotkey="${safeId}"]`));
}

function isAppleUi(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Shortcut labels shown in the message context menu (platform-aware). */
function messageCtxShortcuts(apple = isAppleUi()) {
  return {
    copySelection: apple ? "⌘C" : "Ctrl+C",
    copyMessage: apple ? "⌘⇧C" : "Ctrl+Shift+C",
    copy: apple ? "⌘C" : "Ctrl+C",
    edit: "E",
    like: "L",
    dislike: "D",
    share: "S",
    regenerate: "R",
    readAloud: "A",
  } as const;
}

function useShowHotkeyHints() {
  const [show, setShow] = useState(() => prefersHotkeyHints());
  useEffect(() => subscribeHotkeyHintPreference(() => setShow(prefersHotkeyHints())), []);
  return show;
}

function MsgMenuItem({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={styles.msgActionMenuItem}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      <span className={styles.msgActionMenuLabel}>{label}</span>
      {shortcut ? <span className={styles.msgActionMenuKbd}>{shortcut}</span> : null}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

function MessageArticle({
  msg,
  isLiveAssistant,
  onEditUser,
  onRegenerate,
  activeSession,
  autoExpandSteps,
  stepsGlobalTick,
  keepComposerFocus,
  textareaRef,
}: {
  msg: MessageDto;
  isLiveAssistant: boolean;
  onEditUser: (messageId: string, value: string) => void;
  onRegenerate: () => void;
  activeSession: SessionDetailDto | null;
  autoExpandSteps: boolean;
  stepsGlobalTick: number;
  keepComposerFocus: RefObject<boolean>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <article
      key={msg.id}
      data-message-id={msg.id}
      className={`${styles.msg} ${styles[msg.role]} ${isLiveAssistant ? styles.live : ""}`}
      onMouseEnter={() => setMessageHotkeyHover(msg.id)}
      onMouseLeave={() => setMessageHotkeyHover(null)}
      onMouseDown={(e) => {
        if (!keepComposerFocus.current) return;
        const target = e.target as HTMLElement;
        if (target.closest("button,a,input,textarea")) return;
        const onUp = () => {
          window.removeEventListener("mouseup", onUp);
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().trim()) return;
          textareaRef.current?.focus({ preventScroll: true });
        };
        window.addEventListener("mouseup", onUp);
      }}
    >
      {msg.role === "user" ? (
        <UserMessage message={msg} onEdit={onEditUser} />
      ) : (
        <AssistantParts
          message={msg}
          session={activeSession}
          onRegenerate={onRegenerate}
          streaming={!!isLiveAssistant}
          autoExpandSteps={autoExpandSteps}
          stepsGlobalTick={stepsGlobalTick}
        />
      )}
    </article>
  );
}

function highlightUserText(text: string, knownNames?: Iterable<string>) {
  return splitSlashCommandHighlight(text, knownNames).map((seg, i) =>
    seg.kind === "command" ? (
      <span key={`${i}-${seg.value}`} className={styles.userSlashCmd}>
        {seg.value}
      </span>
    ) : (
      <Fragment key={i}>{seg.value}</Fragment>
    ),
  );
}

function UserMessage({
  message,
  onEdit,
}: {
  message: MessageDto;
  onEdit: (messageId: string, text: string) => void;
}) {
  const text = messagePlainText(message);
  const ctxRef = useRef<MessageCtxHandle | null>(null);
  const fileParts = message.parts.filter((p) => p.type === "file");

  if (!text && fileParts.length === 0) return null;

  const body = (
    <div className={styles.userBubble} contentEditable={false} suppressContentEditableWarning>
      {message.parts.map((part) =>
        part.type === "text" ? (
          <div key={part.id}>{highlightUserText(String(part.payload.text ?? ""))}</div>
        ) : (
          <PartView key={part.id} part={part} />
        ),
      )}
    </div>
  );

  return (
    <div
      className={styles.userMsg}
      data-msg-hotkey={message.id}
      onContextMenu={(e) => {
        // Mobile: keep native long-press text selection; no custom menu.
        if (isTouchUi()) return;
        const target = e.target as HTMLElement;
        if (target.closest("a, button, input, textarea")) return;
        e.preventDefault();
        ctxRef.current?.openAt(e.clientX, e.clientY);
      }}
    >
      {body}
      {fileParts.length > 0 ? (
        <div className={styles.userFiles}>
          {fileParts.map((p) => {
            const name = String(p.payload.name ?? "file");
            const fileId = String(p.payload.fileId ?? "");
            const size = Number(p.payload.size ?? 0);
            const href = fileId
              ? `/api/sessions/${message.sessionId}/attachments/${encodeURIComponent(fileId)}`
              : undefined;
            const chip = (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className={styles.userFileMeta}>
                  <span className={styles.userFileName}>{name}</span>
                  {size > 0 ? (
                    <span className={styles.userFileSize}>{formatBytes(size)}</span>
                  ) : null}
                </span>
              </>
            );
            return (
              <div key={p.id} className={styles.userFileItem}>
                {href && isImageFile(name) ? (
                  <a
                    className={styles.userFilePreviewWrap}
                    href={`${href}?inline=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={name}
                  >
                    <img
                      className={styles.userFilePreview}
                      src={`${href}?inline=1`}
                      alt={name}
                      loading="lazy"
                    />
                  </a>
                ) : null}
                {href ? (
                  <a
                    className={styles.userFileChip}
                    href={href}
                    download={name}
                    title={name}
                  >
                    {chip}
                  </a>
                ) : (
                  <span className={styles.userFileChip}>{chip}</span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      <UserMessageActions
        messageId={message.id}
        text={text}
        createdAt={message.createdAt}
        onEdit={() => onEdit(message.id, text)}
        ctxRef={ctxRef}
      />
    </div>
  );
}

function MsgIcon({ children }: { children: ReactNode }) {
  return (
    <svg className={styles.msgActionIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function IconCopy({ done = false }: { done?: boolean }) {
  if (done) {
    return (
      <MsgIcon>
        <path
          d="M5 13l4 4L19 7"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </MsgIcon>
    );
  }
  return (
    <MsgIcon>
      <rect x="8" y="8" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.85" />
      <path
        d="M8 16H6.5A2.5 2.5 0 0 1 4 13.5v-9A2.5 2.5 0 0 1 6.5 2H15.5A2.5 2.5 0 0 1 18 4.5V8"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </MsgIcon>
  );
}

function IconEdit() {
  return (
    <MsgIcon>
      <path
        d="M4 20h4.8L20 8.8 15.2 4 4 15.2V20Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
      <path d="M12.8 6.8 17.2 11.2" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
    </MsgIcon>
  );
}

/** Speaker glyph sized to match other 24×24 msg-action icons. */
function IconReadAloud() {
  return (
    <MsgIcon>
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
    </MsgIcon>
  );
}

function UserMessageActions({
  messageId,
  text,
  createdAt,
  onEdit,
  ctxRef,
}: {
  messageId: string;
  text: string;
  createdAt: string;
  onEdit: () => void;
  ctxRef?: RefObject<MessageCtxHandle | null>;
}) {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const showHints = useShowHotkeyHints();
  const [copied, setCopied] = useState(false);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxSelection, setCtxSelection] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<(action: MessageHotAction) => boolean>(() => false);

  const copy = async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      showToast(t("common.toastCopied"), { tone: "success", id: "clipboard" });
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  const copySelection = async () => {
    try {
      await copyTextToClipboard(ctxSelection || readDomSelection());
      setCopied(true);
      showToast(t("common.toastCopied"), { tone: "success", id: "clipboard" });
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  const chatActions = settings.chatActions ?? [];
  const menuActions = useMemo(
    () => chatActions.filter((a) => a === "copy" || a === "edit"),
    [chatActions],
  );
  const shortcuts = messageCtxShortcuts();
  const showCtxMenu = Boolean(ctxPos && (menuActions.length > 0 || ctxSelection));

  runRef.current = (action) => {
    if (action === "copySelection") {
      if (!menuActions.includes("copy") && !readDomSelection() && !ctxSelection) return false;
      setCtxPos(null);
      void copySelection().finally(() => setCtxSelection(""));
      return true;
    }
    if (action === "copy") {
      if (!menuActions.includes("copy")) return false;
      setCtxPos(null);
      setCtxSelection("");
      void copy();
      return true;
    }
    if (action === "edit") {
      if (!menuActions.includes("edit")) return false;
      setCtxPos(null);
      setCtxSelection("");
      onEdit();
      return true;
    }
    return false;
  };

  useImperativeHandle(
    ctxRef,
    () => ({
      openAt: (x, y) => {
        setCtxSelection(readDomSelection());
        setCtxPos({
          x: Math.min(Math.max(8, x), window.innerWidth - 240),
          y: Math.min(Math.max(8, y), window.innerHeight - 160),
        });
        setMessageHotkeyHover(messageId);
      },
    }),
    [messageId],
  );

  useEffect(() => {
    const target = {
      id: messageId,
      menuOpen: Boolean(ctxPos),
      has: (action: MessageHotAction) => {
        if (action === "copySelection") return menuActions.includes("copy") || Boolean(readDomSelection());
        if (action === "copy" || action === "edit") return menuActions.includes(action);
        return false;
      },
      run: (action: MessageHotAction) => runRef.current(action),
      selectionInMessage: () => selectionInsideMessage(messageId),
    };
    const unreg = registerMessageHotkeys(target);
    updateMessageHotkeys(target);
    return unreg;
  }, [messageId, ctxPos, menuActions]);

  useEffect(() => {
    if (!ctxPos) return;
    const onDown = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxPos(null);
        setCtxSelection("");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCtxPos(null);
        setCtxSelection("");
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxPos]);

  if (!menuActions.length && !settings.chatShowMessageTime && !showCtxMenu) return null;

  const hint = (value: string | undefined) => (showHints ? value : undefined);

  return (
    <>
      {(menuActions.length > 0 || settings.chatShowMessageTime) && (
        <div className={`${styles.msgActions} ${styles.userMsgActions}`} aria-label={t("common.actions")}>
          {chatActions.map((id) => {
            if (id === "copy") {
              return (
                <button
                  key={id}
                  type="button"
                  className={styles.msgAction}
                  title={copied ? t("common.copied") : t("common.copy")}
                  aria-label={t("common.copy")}
                  onClick={() => void copy()}
                >
                  <IconCopy done={copied} />
                </button>
              );
            }
            if (id === "edit") {
              return (
                <button
                  key={id}
                  type="button"
                  className={styles.msgAction}
                  title={t("common.edit")}
                  aria-label={t("common.edit")}
                  onClick={() => onEdit()}
                >
                  <IconEdit />
                </button>
              );
            }
            return null;
          })}
          {settings.chatShowMessageTime ? (
            <span className={styles.msgTime} aria-hidden>
              {new Date(createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ) : null}
        </div>
      )}
      {showCtxMenu &&
        ctxPos &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.msgActionMenu}
            style={{ left: ctxPos.x, top: ctxPos.y }}
            role="menu"
            aria-label={t("common.actions")}
          >
            {ctxSelection ? (
              <MsgMenuItem
                label={t("common.copySelection")}
                shortcut={hint(shortcuts.copySelection)}
                onClick={() => {
                  setCtxPos(null);
                  void copySelection().finally(() => setCtxSelection(""));
                }}
              >
                <IconCopy />
              </MsgMenuItem>
            ) : null}
            {menuActions.map((id) => {
              if (id === "copy") {
                return (
                  <MsgMenuItem
                    key={id}
                    label={
                      ctxSelection
                        ? t("common.copyMessage")
                        : copied
                          ? t("common.copied")
                          : t("common.copy")
                    }
                    shortcut={hint(ctxSelection ? shortcuts.copyMessage : shortcuts.copy)}
                    onClick={() => {
                      setCtxPos(null);
                      setCtxSelection("");
                      void copy();
                    }}
                  >
                    <IconCopy done={copied} />
                  </MsgMenuItem>
                );
              }
              if (id === "edit") {
                return (
                  <MsgMenuItem
                    key={id}
                    label={t("common.edit")}
                    shortcut={hint(shortcuts.edit)}
                    onClick={() => {
                      setCtxPos(null);
                      setCtxSelection("");
                      onEdit();
                    }}
                  >
                    <IconEdit />
                  </MsgMenuItem>
                );
              }
              return null;
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

function coalesceParts(parts: MessagePartDto[]): MessagePartDto[] {
  const out: MessagePartDto[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    // Merge consecutive parts of the same type (thought, text)
    if (
      prev &&
      part.type === prev.type &&
      (part.type === "thought" || part.type === "text")
    ) {
      out[out.length - 1] = {
        ...prev,
        payload: { ...prev.payload, text: String(prev.payload.text ?? "") + String(part.payload.text ?? "") },
      };
      continue;
    }
    out.push(part);
  }
  return out;
}

function extractStructuredText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        return extractStructuredText(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractStructuredText(item))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.result === "string") return obj.result;
    if (obj.content !== undefined) return extractStructuredText(obj.content);
  }
  return "";
}

function titleFromSubagentBody(text: string): string {
  const heading = text.match(/^###\s+([^\n\[]+?)(?:\s*\[|$)/m);
  if (heading?.[1]?.trim()) return heading[1].trim();
  const label = text.match(/^\s*Label:\s*(.+)$/m);
  if (label?.[1]?.trim()) return label[1].trim();
  const taskResult = text.match(/<task-result\b[^>]*\bid="([^"]+)"/i);
  if (taskResult?.[1]?.trim()) return taskResult[1].trim();
  return "";
}

function resolveSubagentTitle(part: MessagePartDto, body: string): string {
  const raw = (part.payload.raw as Record<string, unknown> | undefined) ?? {};
  const args = (raw.rawInput ?? raw.input ?? raw.arguments) as Record<string, unknown> | undefined;
  const candidates = [
    part.payload.description,
    part.payload.title,
    raw.title,
    raw.description,
    raw.name,
    raw.label,
    args?.description,
    args?.title,
    args?.name,
    titleFromSubagentBody(body),
    part.payload.subagentType,
  ]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .filter((v) => !isGenericSubagentTitle(v));
  return candidates[0] ?? "";
}

/** Result + live thinking. Launch Task prompts stay hidden; completion text that
 *  older sessions stored in `payload.prompt` still shows when it isn't the input prompt. */
function resolveSubagentBody(part: MessagePartDto): string {
  const raw = (part.payload.raw as Record<string, unknown> | undefined) ?? {};
  const args = (raw.rawInput ?? raw.input ?? raw.arguments) as Record<string, unknown> | undefined;
  const launchPrompt = extractStructuredText(args?.prompt).trim();
  const result = (
    extractStructuredText(part.payload.result) ||
    extractStructuredText(raw.result) ||
    extractStructuredText(raw.content) ||
    extractStructuredText(raw.output)
  ).trim();
  const storedPrompt = (
    extractStructuredText(part.payload.prompt) ||
    extractStructuredText(raw.prompt)
  ).trim();
  const completion =
    result ||
    (storedPrompt && storedPrompt !== launchPrompt ? storedPrompt : "");
  const thinking = Array.isArray(part.payload.thinking) ? part.payload.thinking : [];
  const thoughts = thinking
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  if (completion && thoughts) return `${completion}\n\n${thoughts}`;
  return completion || thoughts;
}

/** Compact nested tool → synthetic tool_call part so we reuse ToolCallRow UI. */
function nestedToolAsPart(
  parent: MessagePartDto,
  tool: { name?: string; args?: string; status?: string },
  index: number,
): MessagePartDto {
  const name = String(tool.name ?? "tool").trim() || "tool";
  const argsRaw = String(tool.args ?? "").trim();
  let rawInput: unknown = argsRaw || undefined;
  if (argsRaw.startsWith("{") || argsRaw.startsWith("[")) {
    try {
      rawInput = JSON.parse(argsRaw) as unknown;
    } catch {
      /* keep string */
    }
  }
  const status = String(tool.status ?? "").toLowerCase();
  const normalized =
    status === "running" || status === "in_progress" || status === "pending"
      ? "in_progress"
      : status === "failed"
        ? "failed"
        : "completed";
  const argsText =
    rawInput && typeof rawInput === "object"
      ? JSON.stringify(rawInput, null, 2)
      : argsRaw;
  return {
    id: `${parent.id}:nested-tool:${index}:${name}`,
    messageId: parent.messageId,
    type: "tool_call",
    order: index,
    createdAt: parent.createdAt,
    payload: {
      title: name,
      status: normalized,
      raw: {
        toolName: name,
        ...(rawInput !== undefined ? { rawInput } : {}),
        // Nested feeds rarely include stdout — expose args as expandable detail.
        ...(argsText && normalized !== "in_progress"
          ? { content: [{ type: "content", content: { type: "text", text: argsText } }] }
          : {}),
      },
    },
  };
}

function SubagentForkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="7" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="7" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M9.1 7.2 14.7 11.1M9.1 16.8 14.7 12.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SubagentPartView({
  part,
  streaming,
}: {
  part: MessagePartDto;
  streaming?: boolean;
}) {
  const t = useT();
  const [open, setOpenState] = useState(() => expandedPartIds.get(part.id) ?? false);
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpenState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      expandedPartIds.set(part.id, value);
      return value;
    });
  };

  const body = resolveSubagentBody(part);
  const title = resolveSubagentTitle(part, body);
  const tools = Array.isArray(part.payload.tools)
    ? (part.payload.tools as Array<{ name?: string; args?: string; status?: string }>)
    : [];
  const status = String(part.payload.status ?? "");
  const working = status === "running";
  const live = streaming && status !== "completed" && status !== "failed";
  const busy = working || live;
  const failed = status === "failed";
  const hasContent = Boolean(body.trim() || tools.length);

  // Open as soon as the subagent is live so title + streaming body stay visible.
  useEffect(() => {
    if (busy) setOpen(true);
  }, [busy]);

  return (
    <div
      className={`${styles.subagent} ${open ? styles.subagentOpen : ""} ${
        busy ? styles.subagentBusy : ""
      } ${failed ? styles.subagentFailed : ""}`}
    >
      <button
        type="button"
        className={styles.subagentToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
      >
        <span
          className={`${styles.subagentGlyph} ${busy ? styles.subagentGlyphLive : ""}`}
          aria-hidden
        >
          <SubagentForkIcon />
        </span>
        <span className={styles.subagentLabelWrap}>
          <span className={styles.subagentKind}>{t("agent.subagent")}</span>
          {title ? <span className={styles.subagentTitle}>{title}</span> : null}
        </span>
        {failed ? (
          <span className={styles.subagentStatus}>
            {t("common.subagentFailed").replace(/^\s*·\s*/, "")}
          </span>
        ) : null}
        <svg
          className={`${styles.subagentChevron} ${open ? styles.subagentChevronOpen : ""}`}
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <path
            d="M9 6l6 6-6 6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && hasContent ? (
        <div className={styles.subagentBody}>
          {tools.length ? (
            <div className={styles.subagentTools}>
              {tools.map((tool, i) => {
                const name = String(tool.name ?? "tool").trim() || "tool";
                const args = String(tool.args ?? "").trim();
                const toolBusy =
                  tool.status === "running" ||
                  (busy && i === tools.length - 1 && tool.status !== "completed");
                return (
                  <ToolCallRow
                    key={`${part.id}:nested-tool:${i}:${name}:${args.slice(0, 24)}`}
                    part={nestedToolAsPart(part, tool, i)}
                    streaming={toolBusy}
                  />
                );
              })}
            </div>
          ) : null}
          {body.trim() ? (
            <MarkdownContent text={body} className={styles.subagentMarkdown} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PartView({
  part,
  streaming,
  embedded = false,
}: {
  part: MessagePartDto;
  streaming?: boolean;
  embedded?: boolean;
}) {
  const t = useT();
  const [open, setOpenState] = useState(() => expandedPartIds.get(part.id) ?? false);
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpenState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      expandedPartIds.set(part.id, value);
      return value;
    });
  };

  const toggleProps = {
    type: "button" as const,
    tabIndex: -1,
    className: styles.partToggle,
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
  };

  if (part.type === "text") {
    const text = String(part.payload.text ?? "");
    if (!text.trim()) return null;
    return (
      <MarkdownContent
        text={text}
        streaming={streaming}
        className={embedded ? styles.textEmbedded : streaming ? styles.streaming : undefined}
      />
    );
  }

  if (part.type === "thought") {
    const text = String(part.payload.text ?? "").trim();
    if (!text) return null;
    const body = <div className={styles.thoughtBody}>{renderThoughtText(text)}</div>;
    if (embedded) {
      return (
        <div className={`${styles.thoughtEmbedded} ${streaming ? styles.thoughtLive : ""}`}>
          {body}
        </div>
      );
    }
    // Standalone thoughts are folded into the thinking spoiler; keep a minimal fallback.
    return (
      <div
        className={`${styles.thought} ${open ? styles.thoughtOpen : ""} ${
          streaming ? styles.thoughtLive : ""
        }`}
      >
        <button {...toggleProps} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={styles.thoughtLabel}>
            {streaming && <span className={styles.pulseDot} />}
            {t("common.reasoning")}
          </span>
          <span className={styles.thoughtChevron} aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </button>
        {open && body}
      </div>
    );
  }

  if (part.type === "subagent") {
    return <SubagentPartView part={part} streaming={streaming} />;
  }

  // Regular tool calls stay hidden — only thoughts + subagent cards + answer text.
  // Errors are shown only in the composer banner (store.error), never in-thread.
  if (part.type === "tool_call" || part.type === "error") {
    return null;
  }

  return null;
}

/** Icon for thinking toggle (composer) and in-message thinking header. */
function ThoughtSparkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.2 13.2 8.1 18 9.3 13.2 10.5 12 15.4 10.8 10.5 6 9.3 10.8 8.1 12 3.2Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M18.2 14.2 18.8 16.6 21.2 17.2 18.8 17.8 18.2 20.2 17.6 17.8 15.2 17.2 17.6 16.6 18.2 14.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M6.2 13.8 6.7 15.8 8.7 16.3 6.7 16.8 6.2 18.8 5.7 16.8 3.7 16.3 5.7 15.8 6.2 13.8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
/** Compact token count: 1234 → "1.2k", 1234567 → "1.2M". */
function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const v = n / 1_000_000;
  return `${v.toFixed(1).replace(/\.0$/, "")}M`;
}

function isThoughtPart(part: MessagePartDto) {
  return part.type === "thought" && Boolean(String(part.payload.text ?? "").trim());
}

/** Full text output of a tool call (string or array of content blocks). */
function toolOutputText(part: MessagePartDto): string {
  const raw = (part.payload.raw ?? {}) as Record<string, unknown>;
  const rawOutput = (raw.rawOutput ?? {}) as Record<string, unknown>;
  const content = raw.content ?? rawOutput.content;
  let text = "";
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = (block ?? {}) as Record<string, unknown>;
      const inner = b.content as Record<string, unknown> | undefined;
      const t =
        typeof inner?.text === "string"
          ? inner.text
          : typeof b.text === "string"
            ? b.text
            : "";
      text += t;
    }
  } else if (typeof content === "string") {
    text = content;
  }
  return text.trim();
}

/** Short human-readable outcome of a tool: written/read path or output first line. */
function toolOutputDetail(part: MessagePartDto): string {
  const raw = (part.payload.raw ?? {}) as Record<string, unknown>;
  const rawOutput = (raw.rawOutput ?? {}) as Record<string, unknown>;
  const resolvedPath =
    (rawOutput.details as { resolvedPath?: string } | undefined)?.resolvedPath ?? "";
  const text = toolOutputText(part);
  if (resolvedPath) {
    const short = resolvedPath.split(/[\\/]/).slice(-2).join("/");
    if (text.includes("Successfully wrote")) return `✎ ${short}`;
    if (text.includes("Successfully deleted")) return `− ${short}`;
    return short;
  }
  return text.split("\n")[0]?.slice(0, 90) ?? "";
}

/** Absolute path (file/dir/URL) a tool worked on, when the agent reported it. */
function toolPath(part: MessagePartDto): string {
  const raw = (part.payload.raw ?? {}) as Record<string, unknown>;
  const details = ((raw.rawOutput ?? {}) as Record<string, unknown>).details as
    | Record<string, unknown>
    | undefined;
  if (!details) return "";
  if (typeof details.resolvedPath === "string" && details.resolvedPath) {
    return details.resolvedPath;
  }
  if (typeof details.url === "string" && details.url) {
    return details.url;
  }
  return "";
}

/** Extra meta bits (method, line count) shown next to the tool path. */
function toolMetaExtra(part: MessagePartDto): string {
  const raw = (part.payload.raw ?? {}) as Record<string, unknown>;
  const details = ((raw.rawOutput ?? {}) as Record<string, unknown>).details as
    | Record<string, unknown>
    | undefined;
  if (!details) return "";
  const bits: string[] = [];
  if (typeof details.method === "string" && details.method) {
    bits.push(details.method);
  }
  if (typeof details.totalLines === "number") {
    bits.push(`${details.totalLines} lines`);
  }
  return bits.join(" · ");
}

/** Clickable local path — opens folder in explorer, URLs in browser. */
function PathLink({
  path,
  children,
  className,
}: {
  path: string;
  children?: ReactNode;
  className?: string;
}) {
  const isUrl = /^https?:\/\//i.test(path);
  const open = () => {
    if (isUrl) {
      window.open(path, "_blank", "noopener,noreferrer");
    } else {
      // For files, open the parent folder so the user can see the file
      // in Explorer instead of opening the file in its default editor.
      const sep = path.includes("\\") ? "\\" : "/";
      const lastPart = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
      const isFile = lastPart.includes(".");
      const target = isFile ? path.substring(0, path.lastIndexOf(sep)) : path;
      void api.openPath(target).catch(() => {});
    }
  };
  return (
    <span
      className={`${styles.pathLink}${className ? ` ${className}` : ""}`}
      title={path}
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          open();
        }
      }}
    >
      {children ?? path}
    </span>
  );
}
/** Windows absolute paths (`C:\…` / `C:/…`) inside free text. */
const ABS_PATH_RE = /\b([A-Za-z]:[\\/][^\s"<>|?*]+)/g;

function splitPathText(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(ABS_PATH_RE);
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 1) {
      // Trailing punctuation (`, . : ) ] }`) belongs to the sentence, not the path.
      const openTarget = part.replace(/[.,;:)\]}]+$/, "");
      if (openTarget) {
        out.push(
          <PathLink key={`${keyPrefix}-p${i}`} path={openTarget}>
            {part}
          </PathLink>,
        );
      } else {
        out.push(<Fragment key={`${keyPrefix}-t${i}`}>{part}</Fragment>);
      }
    } else {
      out.push(<Fragment key={`${keyPrefix}-t${i}`}>{part}</Fragment>);
    }
  }
  return out;
}

/** Like splitPathText but also renders URLs as clickable links. */
function splitToolText(text: string, keyPrefix: string): ReactNode[] {
  const pathParts = text.split(ABS_PATH_RE);
  const out: ReactNode[] = [];
  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    if (!part) continue;
    if (i % 2 === 1) {
      // Path match
      const openTarget = part.replace(/[.,;:)\]}]+$/, "");
      if (openTarget) {
        out.push(<PathLink key={`${keyPrefix}-p${i}`} path={openTarget}>{part}</PathLink>);
      } else {
        out.push(<Fragment key={`${keyPrefix}-t${i}`}>{part}</Fragment>);
      }
    } else {
      // Plain text — detect URLs
      out.push(...renderToolText(part, keyPrefix, i));
    }
  }
  return out;
}

/** Render plain text with clickable URLs. */
function renderToolText(text: string, keyPrefix: string, partIdx: number): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const url = match[0];
    parts.push(
      <span
        key={`${keyPrefix}-u${partIdx}-${match.index}`}
        role="link"
        tabIndex={0}
        style={{ color: "var(--accent)", textDecoration: "underline", cursor: "pointer", textUnderlineOffset: "2px" }}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(url, "_blank", "noopener,noreferrer"); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); window.open(url, "_blank", "noopener,noreferrer"); } }}
      >
        {url}
      </span>,
    );
    lastIdx = match.index + url.length;
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts;
}

/** Renders tool output text: paths become PathLink, URLs become clickable links. */
function ToolOutputView({ text }: { text: string }) {
  const isDiff = /^(diff --git |--- |\+\+\+ |@@ )/m.test(text);
  if (!isDiff) {
    return <div className={styles.toolOutput}>{splitToolText(text, "o")}</div>;
  }
  const lines = text.split("\n");
  return (
    <div className={`${styles.toolOutput} ${styles.toolDiff}`}>
      {lines.map((line, idx) => {
        let cls = "";
        if (line.startsWith("+++") || line.startsWith("---")) cls = styles.diffFile;
        else if (line.startsWith("@@")) cls = styles.diffHunk;
        else if (line.startsWith("+")) cls = styles.diffAdd;
        else if (line.startsWith("-")) cls = styles.diffDel;
        return (
          <div key={idx} className={cls}>
            {line === "" ? "\u00A0" : splitToolText(line, `l${idx}`)}
          </div>
        );
      })}
    </div>
  );
}

const TOOL_OUTPUT_CAP = 20000;

// Expand/collapse state survives virtualization remounts: message rows unmount
// when scrolled out of the virtual window, so local useState would lose which
// tool outputs / thought spoilers / steps blocks the user opened.
const expandedPartIds = new Map<string, boolean>();
import { expandedStepsByMessage, clearExpandedStepsOverrides } from "../lib/expandedSteps";

/** Initial height guess for a virtualized message row; refined by measurement. */
function estimateMessageRowHeight(msg: MessageDto | undefined): number {
  if (!msg) return 60;
  let chars = 0;
  let parts = 0;
  for (const p of msg.parts) {
    parts++;
    const text = p.payload?.text ?? p.payload?.message;
    if (typeof text === "string") chars += text.length;
  }
  return Math.min(720, Math.max(56, 56 + parts * 22 + chars * 0.35));
}

function ToolCallRow({ part, streaming }: { part: MessagePartDto; streaming?: boolean }) {
  const t = useT();
  const [open, setOpenState] = useState(() => expandedPartIds.get(part.id) ?? false);
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpenState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      expandedPartIds.set(part.id, value);
      return value;
    });
  };
  // Stored pre-fix parts can still carry a generic MCP label ("MCP: tool") —
  // the real name lives in raw.toolName; Cursor MCP calls only carry the args,
  // so the display falls back to the call's subject (query/path/…).
  const raw = (part.payload.raw ?? {}) as Record<string, unknown>;
  const rawInput = raw.rawInput ?? raw.input ?? raw.arguments;
  const title =
    toolDisplayTitle(
      String(part.payload.title ?? part.payload.description ?? ""),
      typeof raw.toolName === "string" ? raw.toolName : undefined,
      rawInput,
    ) || "Tool";
  const status = String(part.payload.status ?? "").toLowerCase();
  const busy =
    streaming || status === "in_progress" || status === "pending" || status === "running";
  const detail = busy ? "" : toolOutputDetail(part);
  const output = busy ? "" : toolOutputText(part);
  const path = busy ? "" : toolPath(part);
  const metaExtra = busy ? "" : toolMetaExtra(part);

  // Normalize snippets for de-dup comparisons ("✎ " / "− " prefixes, "URL: " prefix).
  const normSnippet = (s: string) =>
    s.replace(/^[✎−]\s*/, "").trim().replace(/^URL:\s*/i, "");

  const hintNorm = normSnippet(detail);
  const pathNorm = normSnippet(path);

  // Skip a leading output line that only restates the collapsed hint or the
  // path (e.g. a search tool whose first result line is the same snippet as
  // the brief info) — otherwise expanding just re-prints the same text.
  let shown = output;
  const firstNorm = normSnippet(shown.split("\n")[0] ?? "");
  if (
    (hintNorm && (firstNorm === hintNorm || firstNorm.startsWith(hintNorm))) ||
    (pathNorm && (firstNorm === pathNorm || firstNorm.startsWith(pathNorm)))
  ) {
    shown = shown.split("\n").slice(1).join("\n").replace(/^\n+/, "");
  }
  const hintCoveredByMeta =
    !!pathNorm &&
    (pathNorm === hintNorm || pathNorm.startsWith(hintNorm) || hintNorm.startsWith(pathNorm));

  const expandable = !busy && shown.trim().length > 0;
  const truncated = shown.length > TOOL_OUTPUT_CAP;
  const displayed = truncated ? shown.slice(0, TOOL_OUTPUT_CAP) : shown;
  const toggle = () => {
    if (expandable) setOpen((v) => !v);
  };
  return (
    <div
      className={`${styles.toolRow} ${busy ? styles.toolRowBusy : ""} ${
        expandable ? styles.toolRowClickable : ""
      }`}
    >
      <button
        type="button"
        className={styles.toolRowMain}
        onClick={toggle}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-label={
          expandable ? (open ? t("common.toolCollapse") : t("common.toolExpand")) : undefined
        }
        title={
          expandable ? (open ? t("common.toolCollapse") : t("common.toolExpand")) : undefined
        }
      >
        {busy ? (
          <span className={styles.toolLoader} aria-hidden />
        ) : (
          <span className={styles.toolCheck} aria-hidden>
            ✓
          </span>
        )}
        <span className={styles.toolName}>{title}</span>
        {busy ? <span className={styles.toolStatus}>{t("common.toolWorking")}</span> : null}
        {expandable ? (
          <svg
            className={`${styles.toolChevron} ${open ? styles.toolChevronOpen : ""}`}
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <path
              d="M9 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
      {open ? (
        <div className={styles.toolBody}>
          {!hintCoveredByMeta && detail ? (
            path ? (
              <PathLink path={path} className={styles.toolDetail}>
                {detail}
              </PathLink>
            ) : (
              <span className={styles.toolDetail}>{detail}</span>
            )
          ) : null}
          {path || metaExtra ? (
            <div className={styles.toolMeta}>
              {path ? <PathLink path={path} /> : null}
              {path && metaExtra ? <span aria-hidden> · </span> : null}
              {metaExtra ? <span>{metaExtra}</span> : null}
            </div>
          ) : null}
          <ToolOutputView
            text={`${displayed}${truncated ? `\n… ${t("common.outputTruncated")}` : ""}`}
          />
        </div>
      ) : null}
      {!open && detail ? (
        path ? (
          <PathLink path={path} className={styles.toolDetail}>
            {detail}
          </PathLink>
        ) : (
          <span className={styles.toolDetail}>{detail}</span>
        )
      ) : null}
    </div>
  );
}

function StepsSpoiler({
  parts,
  streaming,
  autoExpand,
  startedAt,
  messageId,
  stepsGlobalTick,
}: {
  parts: MessagePartDto[];
  streaming: boolean;
  autoExpand: boolean;
  startedAt: string;
  messageId: string;
  stepsGlobalTick: number;
}) {
  const t = useT();
  const [open, setOpenState] = useState(
    () => expandedStepsByMessage.get(messageId) ?? autoExpand,
  );
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpenState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      expandedStepsByMessage.set(messageId, value);
      return value;
    });
  };
  // Keep the empty "Размышления" header mounted across brief streaming→idle
  //→streaming flaps (stale session.updated) so the section never remounts.
  const [holdEmptyLive, setHoldEmptyLive] = useState(streaming);
  useEffect(() => {
    if (streaming) {
      setHoldEmptyLive(true);
      return;
    }
    if (parts.length > 0) {
      setHoldEmptyLive(false);
      return;
    }
    const id = window.setTimeout(() => setHoldEmptyLive(false), 160);
    return () => window.clearTimeout(id);
  }, [streaming, parts.length]);
  const thoughts = parts.filter(isThoughtPart);
  const agentDurationSec = thoughts.reduce((max, part) => {
    const ms = Number(part.payload.durationMs);
    return Number.isFinite(ms) && ms > 0 ? Math.max(max, Math.max(1, Math.round(ms / 1000))) : max;
  }, 0);
  const messageStartedAt = Date.parse(startedAt);
  const startedAtRef = useRef<number | null>(
    Number.isFinite(messageStartedAt) ? messageStartedAt : null,
  );
  const [elapsedSec, setElapsedSec] = useState(() => {
    if (streaming || holdEmptyLive) return 0;
    const value = Date.parse(startedAt);
    return Number.isFinite(value) ? Math.max(1, Math.round((Date.now() - value) / 1000)) : 0;
  });

  // The toggle is the global switch: on → open, off → collapse.
  // Manual per-block toggles survive (incl. virtualization remounts) until the
  // switch value actually changes — a plain `useEffect(setOpen(autoExpand))`
  // would reset every manual toggle on every remount.
  const prevAutoExpandRef = useRef(autoExpand);
  useEffect(() => {
    if (prevAutoExpandRef.current === autoExpand) return;
    prevAutoExpandRef.current = autoExpand;
    setOpen(autoExpand);
  }, [autoExpand, setOpen]);

  // Global switch clicked (Размышления chip): force-sync every block exactly
  // once. The tick value changes only on a chip click — without this guard the
  // effect re-ran on every render (setOpen is a fresh closure) and instantly
  // reverted manual per-message toggles after the first global toggle.
  const prevTickRef = useRef(stepsGlobalTick);
  useEffect(() => {
    if (prevTickRef.current === stepsGlobalTick) return;
    prevTickRef.current = stepsGlobalTick;
    if (stepsGlobalTick === 0) return;
    setOpen(autoExpand);
  }, [stepsGlobalTick, autoExpand, setOpen]);

  const liveHeader = streaming || holdEmptyLive;

  useEffect(() => {
    if (!liveHeader) return;
    if (startedAtRef.current == null) startedAtRef.current = Date.now();
    const tick = () => {
      const start = startedAtRef.current ?? Date.now();
      setElapsedSec(Math.max(1, Math.round((Date.now() - start) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [liveHeader]);

  useEffect(() => {
    if (liveHeader) return;
    if (startedAtRef.current == null) {
      const value = Date.parse(startedAt);
      if (Number.isFinite(value)) startedAtRef.current = value;
    }
    if (startedAtRef.current == null) return;
    setElapsedSec(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)));
  }, [startedAt, liveHeader]);

  // Show the thinking header immediately while the turn is live (even before the
  // first thought token). Hide only when idle with nothing to show.
  if (parts.length === 0 && !liveHeader) return null;

  const stepsLength = parts.length;
  const subagentParts = parts.filter((p) => p.type === "subagent");
  // Keep subagents reachable while thinking — even if the steps spoiler is collapsed.
  const showSubagentsOutside = !open && subagentParts.length > 0;

  // Same title while live — don't flip "Thinking…" ↔ "Thoughts".
  // The elapsed-since-createdAt fallback is only trustworthy while the
  // message is fresh (the server's durationMs stamp may not have arrived
  // yet). Older messages without durationMs — stopped, errored, or imported
  // turns — must not show a number that grows with every reload.
  const fallbackRecent =
    Date.now() - (Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : Date.now()) <
    10 * 60_000;
  const shownSeconds = agentDurationSec || (fallbackRecent ? elapsedSec : 0);
  const label = liveHeader
    ? t("common.steps")
    : shownSeconds > 0
      ? t("common.thoughtFor", {
          seconds: shownSeconds,
          count: shownSeconds,
        })
      : t("common.steps");

  const renderPart = (part: MessagePartDto, idx: number, listLength: number) => {
    const status = String(part.payload.status ?? "").toLowerCase();
    const toolLive =
      status === "in_progress" || status === "pending" || status === "running";
    const isLast = streaming && idx === listLength - 1;
    const live =
      part.type === "tool_call" || part.type === "subagent" ? streaming && toolLive : isLast;
    return part.type === "tool_call" ? (
      <ToolCallRow key={part.id} part={part} streaming={live} />
    ) : (
      <PartView key={part.id} part={part} embedded streaming={live} />
    );
  };

  return (
    <div className={`${styles.steps} ${open ? styles.stepsOpen : ""}`}>
      <button
        type="button"
        tabIndex={-1}
        className={styles.stepsToggle}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.stepsIcon}>
          <ThoughtSparkIcon size={16} />
        </span>
        <span className={styles.stepsTitle}>
          {liveHeader ? <span className={styles.pulseDot} /> : null}
          {label}
        </span>
        <span
          className={`${styles.stepsChevron} ${open ? styles.stepsChevronOpen : ""}`}
          aria-hidden
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M9 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {showSubagentsOutside ? (
        <div className={styles.stepsSubagentsPeek}>
          {subagentParts
            .slice()
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((part, idx) => renderPart(part, idx, subagentParts.length))}
        </div>
      ) : null}
      {open && parts.length > 0 && (
        <div className={styles.stepsBody}>
          {[...parts]
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((part, idx) => renderPart(part, idx, stepsLength))}
        </div>
      )}
    </div>
  );
}

function hasRenderableAssistantContent(parts: MessagePartDto[]) {
  return parts.some((p) => {
    if (p.type === "text" || p.type === "thought") {
      return Boolean(String(p.payload.text ?? "").trim());
    }
    if (p.type === "subagent" || p.type === "tool_call") {
      return true;
    }
    return false;
  });
}

function assistantPlainText(message: MessageDto) {
  return coalesceParts(message.parts)
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload.text ?? ""))
    .join("\n\n")
    .trim();
}

function MessageActions({
  message,
  session,
  onRegenerate,
  hidden = false,
  ctxRef,
}: {
  message: MessageDto;
  session: SessionDetailDto | null;
  onRegenerate: () => void;
  hidden?: boolean;
  ctxRef?: RefObject<MessageCtxHandle | null>;
}) {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const showHints = useShowHotkeyHints();
  const speakingMessageId = useAppStore((s) => s.speakingMessageId);
  const setSpeakingMessageId = useAppStore((s) => s.setSpeakingMessageId);
  const setTtsLoading = useAppStore((s) => s.setTtsLoading);
  const text = messagePlainText(message);
  const [copied, setCopied] = useState(false);
  const [rating, setRatingState] = useState<MsgRating | null>(() => readMessageRating(message.id));
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxSelection, setCtxSelection] = useState("");
  const [shareTip, setShareTip] = useState<{ x: number; y: number; link: string } | null>(null);
  const [dislikeOpen, setDislikeOpen] = useState(false);
  const [dislikeText, setDislikeText] = useState("");
  const [dislikeBusy, setDislikeBusy] = useState(false);
  const [dislikeDone, setDislikeDone] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const shareTipTimer = useRef<number | null>(null);
  const runRef = useRef<(action: MessageHotAction) => boolean>(() => false);
  const speaking = speakingMessageId === message.id;

  useImperativeHandle(
    ctxRef,
    () => ({
      openAt: (x, y) => {
        setMenuPos(null);
        setCtxSelection(readDomSelection());
        setCtxPos({
          x: Math.min(Math.max(8, x), window.innerWidth - 240),
          y: Math.min(Math.max(8, y), window.innerHeight - 280),
        });
        setMessageHotkeyHover(message.id);
      },
    }),
    [message.id],
  );

  const copy = async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      showToast(t("common.toastCopied"), { tone: "success", id: "clipboard" });
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  const copySelection = async () => {
    try {
      await copyTextToClipboard(ctxSelection || readDomSelection());
      setCopied(true);
      showToast(t("common.toastCopied"), { tone: "success", id: "clipboard" });
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  /** Share a deep link to this message: open the same chat, jump to it. */
  const shareAt = async (x: number, y: number) => {
    if (!text) return;
    const base = typeof window !== "undefined" ? window.location.origin : "";
    const link = `${base}/chat?session=${encodeURIComponent(session?.id ?? "")}&message=${encodeURIComponent(message.id)}`;
    try {
      await navigator.clipboard.writeText(link);
      setShareTip({
        x: Math.min(x, window.innerWidth - 240),
        y: Math.min(y + 6, window.innerHeight - 80),
        link,
      });
      if (shareTipTimer.current) window.clearTimeout(shareTipTimer.current);
      shareTipTimer.current = window.setTimeout(() => setShareTip(null), 2600);
    } catch {
      // ignore
    }
  };

  const share = async (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    await shareAt(Math.min(rect.right - 224, window.innerWidth - 240), rect.bottom);
  };

  const setRating = (next: MsgRating | null) => {
    const prev = rating;
    writeMessageRating(message.id, next);
    setRatingState(next);
    // Keep the "liked" collection in sync: like → add, unlike/dislike → drop.
    if (next === "like") {
      saveLikedMessage({
        messageId: message.id,
        sessionId: session?.id ?? "",
        sessionTitle: session?.title ?? "",
        text,
        at: new Date().toISOString(),
      });
      showToast(t("common.toastLiked"), { tone: "success", id: `rate-${message.id}` });
    } else {
      removeLikedMessage(message.id);
      if (next === "dislike") {
        showToast(t("common.toastDisliked"), { tone: "info", id: `rate-${message.id}` });
      } else if (prev === "like") {
        showToast(t("common.toastUnliked"), { tone: "info", id: `rate-${message.id}` });
      }
    }
  };

  useEffect(() => {
    // Stop read-aloud if this message unmounts (session switch, regeneration…).
    return () => {
      if (useAppStore.getState().speakingMessageId === message.id) stopReadAloud();
      if (shareTipTimer.current) window.clearTimeout(shareTipTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  const toggleSpeak = () => {
    setMenuPos(null);
    setCtxPos(null);
    if (speaking) {
      stopReadAloud();
      return;
    }
    const clean = stripMarkdownForSpeech(text);
    if (!clean) return;
    // Flip the stop button immediately; the spinner shows while the engine
    // generates the audio.
    setSpeakingMessageId(message.id);
    setTtsLoading(true);
    startReadAloud(clean, dominantLanguage(clean), settings.ttsVoiceGender ?? "", {
      onPlaying: () => setTtsLoading(false),
      onEnd: () => {
        setSpeakingMessageId(null);
        setTtsLoading(false);
      },
    });
  };

  useEffect(() => {
    if (!menuPos && !ctxPos) return;
    const onDown = (e: Event) => {
      const node = e.target as Node;
      if (menuRef.current?.contains(node) || ctxMenuRef.current?.contains(node)) return;
      setMenuPos(null);
      setCtxPos(null);
      setCtxSelection("");
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuPos(null);
      setCtxPos(null);
      setCtxSelection("");
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuPos, ctxPos]);

  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos({
      x: Math.min(rect.right - 184, window.innerWidth - 200),
      y: rect.bottom + 6,
    });
  };

  const submitDislike = async () => {
    const comment = dislikeText.trim();
    if (!comment || dislikeBusy) return;
    setDislikeBusy(true);
    try {
      await submitDiagnosticsDump({
        reason: "dislike",
        note: comment,
        sessionId: session?.id,
        dislike: { messageId: message.id, role: message.role, text, comment },
      });
      setRating("dislike");
      setDislikeDone(true);
      window.setTimeout(() => {
        setDislikeOpen(false);
        setDislikeDone(false);
        setDislikeText("");
        setDislikeBusy(false);
      }, 1400);
    } catch {
      setDislikeBusy(false);
    }
  };

  const tabIndex = hidden ? -1 : undefined;
  const likeActive = rating === "like";
  const dislikeActive = rating === "dislike";

  // Configurable actions in the user's order. "edit" lives on user messages
  // only. Every enabled action renders as an icon in its configured position
  // (read-aloud included); the "⋯" overflow holds anything beyond the icons.
  const chatActions = settings.chatActions ?? [];
  const enabledActions = useMemo(
    () => chatActions.filter((a) => a !== "edit"),
    [chatActions],
  );
  const iconActions = enabledActions.slice(0, 6);
  const overflowActions = enabledActions.slice(6);

  const runCtxAction = (id: (typeof enabledActions)[number]) => {
    const at = ctxPos;
    setCtxPos(null);
    setCtxSelection("");
    switch (id) {
      case "copy":
        void copy();
        break;
      case "like":
        setRating(likeActive ? null : "like");
        break;
      case "dislike":
        setDislikeOpen(true);
        break;
      case "share":
        if (at) void shareAt(at.x, at.y);
        else void shareAt(window.innerWidth - 40, window.innerHeight - 40);
        break;
      case "regenerate":
        onRegenerate();
        break;
      case "readAloud":
        toggleSpeak();
        break;
      default:
        break;
    }
  };

  runRef.current = (action) => {
    if (action === "copySelection") {
      if (!enabledActions.includes("copy")) return false;
      setCtxPos(null);
      void copySelection().finally(() => setCtxSelection(""));
      return true;
    }
    if (action === "copy" || action === "like" || action === "dislike" || action === "share" || action === "regenerate" || action === "readAloud") {
      if (!enabledActions.includes(action)) return false;
      if (action === "regenerate" && !session) return false;
      runCtxAction(action);
      return true;
    }
    return false;
  };

  useEffect(() => {
    const target = {
      id: message.id,
      menuOpen: Boolean(ctxPos),
      has: (action: MessageHotAction) => {
        if (action === "copySelection") return enabledActions.includes("copy");
        if (action === "edit") return false;
        return enabledActions.includes(action) && !(action === "regenerate" && !session);
      },
      run: (action: MessageHotAction) => runRef.current(action),
      selectionInMessage: () => selectionInsideMessage(message.id),
    };
    const unreg = registerMessageHotkeys(target);
    updateMessageHotkeys(target);
    return unreg;
  }, [message.id, ctxPos, enabledActions, session]);

  const shortcuts = messageCtxShortcuts();
  const hint = (value: string | undefined) => (showHints ? value : undefined);

  const ctxShortcut = (id: (typeof enabledActions)[number]) => {
    switch (id) {
      case "copy":
        return hint(ctxSelection ? shortcuts.copyMessage : shortcuts.copy);
      case "like":
        return hint(shortcuts.like);
      case "dislike":
        return hint(shortcuts.dislike);
      case "share":
        return hint(shortcuts.share);
      case "regenerate":
        return hint(shortcuts.regenerate);
      case "readAloud":
        return hint(shortcuts.readAloud);
      default:
        return undefined;
    }
  };

  const ctxLabel = (id: (typeof enabledActions)[number]) => {
    switch (id) {
      case "copy":
        return ctxSelection
          ? t("common.copyMessage")
          : copied
            ? t("common.copied")
            : t("common.copy");
      case "like":
        return likeActive ? t("chat.liked") : t("common.like");
      case "dislike":
        return dislikeActive ? t("chat.disliked") : t("common.dislike");
      case "share":
        return t("common.share");
      case "regenerate":
        return t("chat.regenerate");
      case "readAloud":
        return speaking ? t("chat.stopReading") : t("chat.readAloud");
      default:
        return id;
    }
  };

  const renderIconAction = (id: (typeof iconActions)[number]) => {
    switch (id) {
      case "copy":
        return (
          <button
            type="button"
            className={styles.msgAction}
            title={copied ? t("common.copied") : t("common.copy")}
            aria-label={t("common.copy")}
            tabIndex={tabIndex}
            onClick={() => void copy()}
          >
            <IconCopy done={copied} />
          </button>
        );
      case "like":
        return (
          <button
            type="button"
            className={`${styles.msgAction}${likeActive ? ` ${styles.msgActionActive}` : ""}`}
            title={likeActive ? t("chat.liked") : t("common.like")}
            aria-label={likeActive ? t("chat.liked") : t("common.like")}
            aria-pressed={likeActive}
            tabIndex={tabIndex}
            onClick={() => setRating(likeActive ? null : "like")}
          >
            <MsgIcon>
              <path
                d="M7 11v9H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h2Zm0 0 4.2-7.2A2.2 2.2 0 0 1 13.2 3h.3a2 2 0 0 1 2 2.3L14.8 11H20a2 2 0 0 1 2 2.3l-1.1 5.2A3 3 0 0 1 18 21H7"
                stroke="currentColor"
                strokeWidth="1.85"
                strokeLinejoin="round"
              />
            </MsgIcon>
          </button>
        );
      case "dislike":
        return (
          <button
            type="button"
            className={`${styles.msgAction}${dislikeActive ? ` ${styles.msgActionActive}` : ""}`}
            title={dislikeActive ? t("chat.disliked") : t("common.dislike")}
            aria-label={dislikeActive ? t("chat.disliked") : t("common.dislike")}
            aria-pressed={dislikeActive}
            tabIndex={tabIndex}
            onClick={() => setDislikeOpen(true)}
          >
            <MsgIcon>
              <path
                d="M17 13V4h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2Zm0 0-4.2 7.2A2.2 2.2 0 0 1 10.8 21h-.3a2 2 0 0 1-2-2.3L9.2 13H4a2 2 0 0 1-2-2.3L3.1 5.5A3 3 0 0 1 6 3h11"
                stroke="currentColor"
                strokeWidth="1.85"
                strokeLinejoin="round"
              />
            </MsgIcon>
          </button>
        );
      case "share":
        return (
          <button
            type="button"
            className={styles.msgAction}
            title={t("common.share")}
            aria-label={t("common.share")}
            tabIndex={tabIndex}
            onClick={(e) => void share(e)}
          >
            <MsgIcon>
              <path
                d="M12 3v10M12 3l-3.5 3.5M12 3l3.5 3.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
                stroke="currentColor"
                strokeWidth="1.85"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </MsgIcon>
          </button>
        );
      case "regenerate":
        return (
          <button
            type="button"
            className={styles.msgAction}
            title={t("chat.regenerate")}
            aria-label={t("chat.regenerate")}
            disabled={!session}
            tabIndex={tabIndex}
            onClick={onRegenerate}
          >
            <MsgIcon>
              <path
                d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4"
                stroke="currentColor"
                strokeWidth="1.85"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </MsgIcon>
          </button>
        );
      case "readAloud":
        return (
          <button
            type="button"
            className={`${styles.msgAction}${speaking ? ` ${styles.msgActionActive}` : ""}`}
            title={speaking ? t("chat.stopReading") : t("chat.readAloud")}
            aria-label={speaking ? t("chat.stopReading") : t("chat.readAloud")}
            aria-pressed={speaking}
            tabIndex={tabIndex}
            onClick={toggleSpeak}
          >
            <IconReadAloud />
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={`${styles.msgActions}${hidden ? ` ${styles.msgActionsHidden}` : ""}`}
      aria-label={t("common.actions")}
      aria-hidden={hidden}
    >
      {iconActions.map((id) => renderIconAction(id))}
      {overflowActions.length > 0 && (
        <button
          type="button"
          className={styles.msgAction}
          title={t("common.more")}
          aria-label={t("common.more")}
          aria-haspopup="menu"
          aria-expanded={Boolean(menuPos)}
          tabIndex={tabIndex}
          onClick={openMenu}
        >
          <MsgIcon>
            <circle cx="5" cy="12" r="1.7" fill="currentColor" />
            <circle cx="12" cy="12" r="1.7" fill="currentColor" />
            <circle cx="19" cy="12" r="1.7" fill="currentColor" />
          </MsgIcon>
        </button>
      )}

      {settings.chatShowMessageTime ? (
        <span className={styles.msgTime} aria-hidden>
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      ) : null}

      {menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.msgActionMenu}
            style={{ left: menuPos.x, top: menuPos.y }}
            role="menu"
            aria-label={t("common.more")}
          >
            {overflowActions.map((id) =>
              id === "readAloud" ? (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  className={styles.msgActionMenuItem}
                  onClick={toggleSpeak}
                >
                  <IconReadAloud />
                  {speaking ? t("chat.stopReading") : t("chat.readAloud")}
                </button>
              ) : null,
            )}
          </div>,
          document.body,
        )}

      {ctxPos &&
        (enabledActions.length > 0 || ctxSelection) &&
        createPortal(
          <div
            ref={ctxMenuRef}
            className={styles.msgActionMenu}
            style={{ left: ctxPos.x, top: ctxPos.y }}
            role="menu"
            aria-label={t("common.actions")}
          >
            {ctxSelection ? (
              <MsgMenuItem
                label={t("common.copySelection")}
                shortcut={hint(shortcuts.copySelection)}
                onClick={() => {
                  setCtxPos(null);
                  void copySelection().finally(() => setCtxSelection(""));
                }}
              >
                <IconCopy />
              </MsgMenuItem>
            ) : null}
            {enabledActions.map((id) => (
              <MsgMenuItem
                key={id}
                label={ctxLabel(id)}
                shortcut={ctxShortcut(id)}
                disabled={id === "regenerate" && !session}
                onClick={() => runCtxAction(id)}
              >
                {id === "copy" ? <IconCopy done={copied} /> : null}
                {id === "like" ? (
                  <MsgIcon>
                    <path
                      d="M7 11v9H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h2Zm0 0 4.2-7.2A2.2 2.2 0 0 1 13.2 3h.3a2 2 0 0 1 2 2.3L14.8 11H20a2 2 0 0 1 2 2.3l-1.1 5.2A3 3 0 0 1 18 21H7"
                      stroke="currentColor"
                      strokeWidth="1.85"
                      strokeLinejoin="round"
                    />
                  </MsgIcon>
                ) : null}
                {id === "dislike" ? (
                  <MsgIcon>
                    <path
                      d="M17 13V4h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2Zm0 0-4.2 7.2A2.2 2.2 0 0 1 10.8 21h-.3a2 2 0 0 1-2-2.3L9.2 13H4a2 2 0 0 1-2-2.3L3.1 5.5A3 3 0 0 1 6 3h11"
                      stroke="currentColor"
                      strokeWidth="1.85"
                      strokeLinejoin="round"
                    />
                  </MsgIcon>
                ) : null}
                {id === "share" ? (
                  <MsgIcon>
                    <path
                      d="M12 3v10M12 3l-3.5 3.5M12 3l3.5 3.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
                      stroke="currentColor"
                      strokeWidth="1.85"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </MsgIcon>
                ) : null}
                {id === "regenerate" ? (
                  <MsgIcon>
                    <path
                      d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4"
                      stroke="currentColor"
                      strokeWidth="1.85"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </MsgIcon>
                ) : null}
                {id === "readAloud" ? <IconReadAloud /> : null}
              </MsgMenuItem>
            ))}
          </div>,
          document.body,
        )}

      {shareTip &&
        createPortal(
          <div
            className={styles.msgShareTip}
            style={{ left: shareTip.x, top: shareTip.y }}
            role="status"
          >
            <span className={styles.msgShareTipLabel}>{t("chat.shareCopied")}</span>
            <code className={styles.msgShareTipLink}>{shareTip.link}</code>
          </div>,
          document.body,
        )}

      {dislikeOpen &&
        createPortal(
          <AppDialog
            title={t("chat.dislikeTitle")}
            description={t("chat.dislikeDesc")}
            onClose={() => {
              if (!dislikeBusy) setDislikeOpen(false);
            }}
            actions={
              dislikeDone ? (
                <span className={styles.dislikeDone}>{t("chat.dislikeSent")}</span>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.dialogGhost}
                    disabled={dislikeBusy}
                    onClick={() => setDislikeOpen(false)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className={styles.dialogPrimary}
                    disabled={!dislikeText.trim() || dislikeBusy}
                    onClick={() => void submitDislike()}
                  >
                    {dislikeBusy ? t("chat.dislikeSending") : t("chat.dislikeSubmit")}
                  </button>
                </>
              )
            }
          >
            <textarea
              className={styles.dislikeField}
              value={dislikeText}
              onChange={(e) => setDislikeText(e.target.value)}
              placeholder={t("chat.dislikePlaceholder")}
              rows={4}
              autoFocus
            />
          </AppDialog>,
          document.body,
        )}
    </div>
  );
}

function subagentKey(part: MessagePartDto): string | null {
  const id = String(
    part.payload.toolCallId ??
      part.payload.tool_call_id ??
      (part.payload.raw as { toolCallId?: string; tool_call_id?: string } | undefined)?.toolCallId ??
      (part.payload.raw as { tool_call_id?: string } | undefined)?.tool_call_id ??
      "",
  ).trim();
  if (id) return `call:${id}`;
  const taskId = String(
    part.payload.task_id ??
      part.payload.taskId ??
      (part.payload.raw as { task_id?: string; taskId?: string } | undefined)?.task_id ??
      (part.payload.raw as { taskId?: string } | undefined)?.taskId ??
      "",
  ).trim();
  if (taskId) return `task:${taskId}`;
  // omp roster/progress cards carry the registry agent id; merge duplicate
  // cards for the same agent (e.g. one from tool_call routing, one from
  // _omp/agents/update) into a single card.
  const agentId = String(part.payload.agentId ?? "").trim();
  if (agentId) return `agent:${agentId}`;
  return null;
}

function subagentDisplayTitle(part: MessagePartDto): string {
  const raw = (part.payload.raw as Record<string, unknown> | undefined) ?? {};
  const args = (raw.rawInput ?? raw.input ?? raw.arguments) as Record<string, unknown> | undefined;
  const candidates = [
    part.payload.description,
    part.payload.title,
    args?.description,
    args?.title,
    raw.description,
    raw.title,
    part.payload.subagentType,
  ]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v && !isPlaceholderSubagentTitle(v));
  return candidates[0] ?? "";
}

function isGenericSubagentTitle(title: string) {
  return isPlaceholderSubagentTitle(title);
}

function preferSubagentPart(a: MessagePartDto, b: MessagePartDto): MessagePartDto {
  const aTitle = subagentDisplayTitle(a);
  const bTitle = subagentDisplayTitle(b);
  const aGeneric = isGenericSubagentTitle(aTitle);
  const bGeneric = isGenericSubagentTitle(bTitle);
  if (aGeneric && !bGeneric) return { ...a, payload: { ...a.payload, ...b.payload, title: bTitle || aTitle, description: bTitle || aTitle } };
  if (!aGeneric && bGeneric) return { ...a, payload: { ...a.payload, ...b.payload, title: aTitle, description: aTitle } };
  // Prefer longer/more specific title, keep richer payload.
  const title = bTitle.length > aTitle.length ? bTitle : aTitle;
  return {
    ...a,
    type: "subagent",
    payload: {
      ...a.payload,
      ...b.payload,
      title: title || aTitle || bTitle || "",
      description: title || aTitle || bTitle || "",
    },
  };
}

function isSubagentLike(part: MessagePartDto) {
  if (part.type === "subagent") return true;
  if (part.type !== "tool_call") return false;
  const raw = (part.payload.raw as Record<string, unknown> | undefined) ?? {};
  const kind = String(raw.kind ?? part.payload.kind ?? "").trim();
  const toolName = String(raw.toolName ?? "").trim();
  const title = String(part.payload.title ?? part.payload.description ?? "").trim();
  // Registered adapters' subagent tool kinds + the built-in heuristic fallback.
  const metaKinds = useAppStore.getState().adapters.flatMap((a) => a.subagentToolKinds);
  if (isSubagentToolCall(kind) || metaKinds.includes(kind.toLowerCase())) return true;
  if (isSubagentToolCall(toolName) || metaKinds.includes(toolName.toLowerCase())) return true;
  // Cursor sometimes emits the Task spawn as a plain tool_call titled "Task: …".
  if (/^task\s*:/i.test(title)) return true;
  // Cursor Task often arrives as kind=other with description+prompt args.
  if (kind.toLowerCase() === "other") {
    const args = (raw.rawInput ?? raw.input ?? raw.arguments) as Record<string, unknown> | undefined;
    if (
      typeof args?.description === "string" &&
      args.description.trim() &&
      typeof args?.prompt === "string" &&
      args.prompt.trim()
    ) {
      return true;
    }
  }
  return false;
}

function coalesceAssistantParts(
  parts: MessagePartDto[],
): MessagePartDto[] {
  const coalesced = coalesceParts(parts);
  const out: MessagePartDto[] = [];
  const subagentIndexByKey = new Map<string, number>();

  for (const part of coalesced) {
    if (part.type === "error") {
      // Composer banner only — never keep error parts in the visible thread model.
      continue;
    }
    if (part.type === "thought" || part.type === "text") {
      out.push(part);
      continue;
    }

    const raw = (part.payload.raw as Record<string, unknown> | undefined) ?? {};
    const toolName = String(raw.toolName ?? "").trim().toLowerCase();
    const title = String(part.payload.title ?? part.payload.description ?? "").trim();
    const looksLikeTaskSpawn =
      toolName === "task" || /^task\s*:/i.test(title) || /^subagent(\s+task)?$/i.test(title);

    // Drop redundant Task spawn tool rows when they aren't promoteable, or
    // continue into subagent promotion below when they are.
    // Cursor often sends Task with empty rawInput at start — still promote.
    if (part.type === "tool_call" && looksLikeTaskSpawn && !isSubagentLike(part)) {
      const asEarly: MessagePartDto = {
        ...part,
        type: "subagent",
        payload: {
          ...part.payload,
          status:
            part.payload.status === "pending" || part.payload.status === "in_progress"
              ? "running"
              : part.payload.status || "running",
        },
      };
      const key = subagentKey(asEarly);
      if (key && subagentIndexByKey.has(key)) {
        const idx = subagentIndexByKey.get(key)!;
        out[idx] = preferSubagentPart(out[idx], asEarly);
        continue;
      }
      if (key) subagentIndexByKey.set(key, out.length);
      out.push(asEarly);
      continue;
    }

    // Regular tool calls surface inside the thinking block.
    if (!isSubagentLike(part)) {
      out.push(part);
      continue;
    }

    const args = (raw.rawInput ?? raw.input ?? raw.arguments) as Record<string, unknown> | undefined;
    const betterTitle = String(
      part.payload.description ??
        args?.description ??
        raw.description ??
        part.payload.title ??
        "",
    ).trim();
    const asSubagent: MessagePartDto =
      part.type === "tool_call"
        ? {
            ...part,
            type: "subagent",
            payload: {
              ...part.payload,
              ...(betterTitle && !isGenericSubagentTitle(betterTitle)
                ? { title: betterTitle, description: betterTitle }
                : {}),
              status:
                part.payload.status === "pending" || part.payload.status === "in_progress"
                  ? "running"
                  : part.payload.status,
            },
          }
        : part;
    const key = subagentKey(asSubagent);

    if (key && subagentIndexByKey.has(key)) {
      const idx = subagentIndexByKey.get(key)!;
      out[idx] = preferSubagentPart(out[idx], asSubagent);
      continue;
    }

    // Drop completed placeholder cards only — never hide a live subagent just
    // because another one already has a nicer title (that caused staggered appearance).
    const cardTitle = subagentDisplayTitle(asSubagent);
    const cardStatus = String(asSubagent.payload.status ?? "").toLowerCase();
    const cardLive =
      cardStatus === "running" ||
      cardStatus === "pending" ||
      cardStatus === "in_progress" ||
      !cardStatus;
    if (
      !cardLive &&
      (isGenericSubagentTitle(cardTitle) || /^task\s*:/i.test(cardTitle))
    ) {
      const hasNamed = out.some(
        (p) => p.type === "subagent" && !isGenericSubagentTitle(subagentDisplayTitle(p)),
      );
      if (hasNamed) continue;
    }

    if (key) subagentIndexByKey.set(key, out.length);
    out.push(asSubagent);
  }

  return out;
}

/** Last text part in emission order — the final answer of the turn. */
function lastTextPart(parts: MessagePartDto[]): MessagePartDto | null {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i]?.type === "text") return parts[i];
  }
  return null;
}

function AssistantParts({
  message,
  session,
  onRegenerate,
  streaming,
  autoExpandSteps,
  stepsGlobalTick,
}: {
  message: MessageDto;
  session: SessionDetailDto | null;
  onRegenerate: () => void;
  streaming: boolean;
  autoExpandSteps: boolean;
  stepsGlobalTick: number;
}) {
  // Keep typewriter "live" after the turn so late/peeled text still types out
  // instead of dumping in one frame when status flips to idle.
  const [paintStreaming, setPaintStreaming] = useState(streaming);
  const wasStreamingRef = useRef(streaming);
  useEffect(() => {
    if (streaming) {
      wasStreamingRef.current = true;
      setPaintStreaming(true);
      return;
    }
    // After a user-initiated stop (session already idle), show actions
    // immediately — no need to wait for late-arriving text.
    if (wasStreamingRef.current && session?.status === "idle") {
      wasStreamingRef.current = false;
      setPaintStreaming(false);
      return;
    }
    wasStreamingRef.current = false;
    const id = window.setTimeout(() => setPaintStreaming(false), 3200);
    return () => window.clearTimeout(id);
  }, [streaming, session?.status]);

  const parts = useMemo(() => {
    return coalesceAssistantParts(message.parts);
  }, [message.parts]);

  // The final answer (last text part in emission order) stays outside the
  // steps block; intermediate texts, tools, and subagents interleave inside
  // it in emission order — same nesting as Cursor's thinking transcript.
  const stepsParts = useMemo(() => {
    const finalText = lastTextPart(parts);
    return parts.filter((p) => p !== finalText && p.type !== "error");
  }, [parts]);
  const mainParts = useMemo(() => {
    const finalText = lastTextPart(parts);
    return parts.filter((p) => p === finalText && p.type !== "error");
  }, [parts]);
  const plain = useMemo(() => {
    return mainParts
      .filter((p) => p.type === "text")
      .map((p) => String(p.payload.text ?? ""))
      .join("\n\n")
      .trim();
  }, [mainParts]);
  const actionsCtxRef = useRef<MessageCtxHandle | null>(null);

  return (
    <div
      className={styles.parts}
      data-msg-hotkey={message.id}
      onContextMenu={(e) => {
        if (isTouchUi()) return;
        const target = e.target as HTMLElement;
        if (target.closest("a, button, input, textarea")) return;
        if (!plain) return;
        e.preventDefault();
        actionsCtxRef.current?.openAt(e.clientX, e.clientY);
      }}
    >
      <StepsSpoiler
        parts={stepsParts}
        streaming={streaming}
        autoExpand={autoExpandSteps}
        startedAt={message.createdAt}
        messageId={message.id}
        stepsGlobalTick={stepsGlobalTick}
      />
      {mainParts.map((part, idx) => {
        const isLast = idx === mainParts.length - 1;
        return (
          <PartView
            key={part.id}
            part={part}
            streaming={
              paintStreaming && isLast && part.type === "text"
            }
          />
        );
      })}
      {plain ? (
        <MessageActions
          message={message}
          session={session}
          onRegenerate={onRegenerate}
          hidden={paintStreaming}
          ctxRef={actionsCtxRef}
        />
      ) : null}
    </div>
  );
}

function findLatestPlan(session: { messages: MessageDto[] } | null): PlanPayload | null {
  if (!session) return null;
  for (let mi = session.messages.length - 1; mi >= 0; mi -= 1) {
    const parts = session.messages[mi]?.parts ?? [];
    for (let pi = parts.length - 1; pi >= 0; pi -= 1) {
      const part = parts[pi];
      if (!part) continue;
      if (part.type === "plan" || part.type === "question" || part.type === "permission") {
        const coerced = coercePlanPayload(part.payload);
        if (coerced) return coerced;
      }
    }
  }
  return null;
}

function modelParamsEqual(a: Record<string, string>, b: Record<string, string>) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

type ChatPaneBind = {
  sessionId: string | null;
  paneIndex: number;
  paneCount: number;
  focused: boolean;
};

const ChatPaneContext = createContext<ChatPaneBind | null>(null);

/** Per-session composer drafts — survive chat switches until reload. */
const composerDrafts = new Map<string, string>();

function rememberComposerDraft(sessionId: string | null | undefined, value: string) {
  if (!sessionId) return;
  if (value) composerDrafts.set(sessionId, value);
  else composerDrafts.delete(sessionId);
}

function forgetComposerDraft(sessionId: string | null | undefined) {
  if (sessionId) composerDrafts.delete(sessionId);
}

function useDesktopSplit() {
  const [desktop, setDesktop] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= CHAT_SPLIT_MIN_PX,
  );
  const collapseToSinglePane = useAppStore((s) => s.collapseToSinglePane);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${CHAT_SPLIT_MIN_PX}px)`);
    const onChange = () => {
      setDesktop(mq.matches);
      if (!mq.matches) collapseToSinglePane();
    };
    mq.addEventListener("change", onChange);
    if (!mq.matches) collapseToSinglePane();
    return () => mq.removeEventListener("change", onChange);
  }, [collapseToSinglePane]);
  return desktop;
}

function ChatThread() {
  const bind = useContext(ChatPaneContext);
  const t = useT();
  const navigate = useNavigate();
  const { search } = useBrowserLocation();
  const activeSession = useAppStore((s) =>
    bind?.sessionId ? selectLiveSessionDetail(s, bind.sessionId) : s.activeSession,
  );
  const loading = useAppStore((s) => s.loading);
  const sessionLoading = useAppStore(
    (s) => Boolean(bind?.sessionId) && s.activeSessionId === bind?.sessionId && s.sessionLoading,
  );
  const restoring = useAppStore((s) => {
    const id = bind?.sessionId ?? s.activeSessionId;
    return Boolean(id && s.restoringSessionIds[id]);
  });
  const selectSession = useAppStore((s) => s.selectSession);
  const focusMessageId = useAppStore((s) => s.focusMessageId);
  const setFocusMessageId = useAppStore((s) => s.setFocusMessageId);
  const speakingMessageId = useAppStore((s) => s.speakingMessageId);
  const ttsLoading = useAppStore((s) => s.ttsLoading);
  // Don't subscribe to the full sessions list — tree reorder (lastMessageAt)
  // would re-render the chat pane for no reason. Only take what the pane needs.
  const hasSessions = useAppStore((s) => s.sessions.length > 0);
  const storeActiveSessionId = useAppStore((s) => s.activeSessionId);
  // Keep the skeleton visible for at least a moment so fast loads don't
  // flash a blank thread. The timer runs once per appearance and survives
  // the data arriving early (no cleanup on showSkeleton flip).
  const [skeletonHold, setSkeletonHold] = useState(false);
  const skeletonTimerRef = useRef<number | null>(null);
  const showSkeleton = bind?.sessionId
    ? sessionLoading || (!activeSession && (loading || hasSessions))
    : sessionLoading || (!activeSession && (loading || hasSessions));
  useEffect(() => {
    if (!showSkeleton) return;
    setSkeletonHold(true);
    if (skeletonTimerRef.current !== null) return;
    skeletonTimerRef.current = window.setTimeout(() => {
      skeletonTimerRef.current = null;
      setSkeletonHold(false);
    }, 350);
  }, [showSkeleton]);
  const renderSkeleton = showSkeleton || skeletonHold;
  const settings = useAppStore((s) => s.settings);
  const consoleOpen = useAppStore((s) => s.consoleOpen);
  const setConsoleOpen = useAppStore((s) => s.setConsoleOpen);
  const toggleConsoleOpen = useAppStore((s) => s.toggleConsoleOpen);
  const consoleLive = activeSession?.status === "running" || activeSession?.status === "waiting";
  const saveSettings = useAppStore((s) => s.saveSettings);
  const sendPromptStore = useAppStore((s) => s.sendPrompt);
  const sendPrompt = useCallback(
    (text: string, opts?: { editMessageId?: string; attachments?: PendingAttachment[] }) =>
      sendPromptStore(text, { ...opts, sessionId: bind?.sessionId ?? undefined }),
    [sendPromptStore, bind?.sessionId],
  );
  const cancelPromptStore = useAppStore((s) => s.cancelPrompt);
  const cancelPrompt = useCallback(
    () => cancelPromptStore(bind?.sessionId ?? undefined),
    [cancelPromptStore, bind?.sessionId],
  );
  const createSession = useAppStore((s) => s.createSession);
  const importHarnessSession = useAppStore((s) => s.importHarnessSession);
  const agentAvailability = useAppStore((s) => s.agentAvailability);
  const adapters = useAppStore((s) => s.adapters);
  const error = useAppStore((s) => (!bind || bind.focused ? s.error : null));
  const modelsCatalog = useAppStore((s) => s.modelsCatalog);
  const modelsLoading = useAppStore((s) => s.modelsLoading);
  const ensureModels = useAppStore((s) => s.ensureModels);
  const rememberModelsCatalog = useAppStore((s) => s.rememberModelsCatalog);
  const pendingPermission = useAppStore((s) => {
    const p = s.pendingPermission;
    if (!p) return null;
    if (bind?.sessionId && p.sessionId !== bind.sessionId) return null;
    return p;
  });
  const pendingQuestion = useAppStore((s) => {
    const p = s.pendingQuestion;
    if (!p) return null;
    if (bind?.sessionId && p.sessionId !== bind.sessionId) return null;
    return p;
  });
  const answerQuestion = useAppStore((s) => s.answerQuestion);
  const promptQueueAll = useAppStore((s) => s.promptQueue);
  const promptQueue = useMemo(
    () =>
      bind?.sessionId
        ? promptQueueAll.filter((q) => q.sessionId === bind.sessionId)
        : promptQueueAll,
    [bind?.sessionId, promptQueueAll],
  );
  const inflight = useAppStore((s) =>
    bind?.sessionId ? (s.inflightBySession?.[bind.sessionId] ?? 0) : s.inflight,
  );
  const removeQueuedPrompt = useAppStore((s) => s.removeQueuedPrompt);
  const [text, setText] = useState("");
  const textRef = useRef(text);
  textRef.current = text;
  const composerSessionId = bind?.sessionId ?? activeSession?.id ?? null;
  const composerSessionRef = useRef<string | null>(null);
  const hasText = text.trim().length > 0;
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [composerMultiline, setComposerMultiline] = useState(false);
  const composerMultilineRef = useRef(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashKeyboardNav, setSlashKeyboardNav] = useState(false);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [planPanelOpen, setPlanPanelOpen] = useState(false);
  const prevPaneCountRef = useRef(bind?.paneCount ?? 1);

  useEffect(() => {
    const n = bind?.paneCount ?? 1;
    if (prevPaneCountRef.current <= 1 && n > 1) {
      setPlanPanelOpen(false);
      setConsoleOpen(false);
    }
    prevPaneCountRef.current = n;
  }, [bind?.paneCount, setConsoleOpen]);
  const [modelParamValues, setModelParamValues] = useState<Record<string, string>>(
    () => modelParamsForSession(settings, null),
  );
  const [model, setModel] = useState(modelForProvider(settings, settings.defaultProvider));
  const [folderPicker, setFolderPicker] = useState<{ x: number; y: number } | null>(null);
  const [autoExpandSteps, setAutoExpandSteps] = useState(() => {
    try {
      // v2: thinking/steps open by default (legacy key defaulted to off).
      const raw = localStorage.getItem("acprocess.autoExpandSteps.v2");
      if (raw === null) return true;
      return raw === "1";
    } catch {
      return true;
    }
  });
  const [stepsGlobalTick, setStepsGlobalTick] = useState(0);
  const syncAutoExpandSteps = useCallback((open: boolean) => {
    clearExpandedStepsOverrides();
    setAutoExpandSteps(open);
    setStepsGlobalTick((tick) => tick + 1);
    try {
      localStorage.setItem("acprocess.autoExpandSteps.v2", open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [stableParams, setStableParams] = useState<ModelParamDto[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerHighlightInnerRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const userJustSentRef = useRef(false);
  const keepComposerFocus = useRef(false);
  const paramsCacheRef = useRef(new Map<string, ModelParamDto[]>());
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const voiceSupported = useMemo(
    () =>
      typeof window !== "undefined" &&
      Boolean(
        (window as SpeechRecognitionWindow).SpeechRecognition ??
          (window as SpeechRecognitionWindow).webkitSpeechRecognition,
      ),
    [],
  );

  const toggleVoiceInput = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor =
      (window as SpeechRecognitionWindow).SpeechRecognition ??
      (window as SpeechRecognitionWindow).webkitSpeechRecognition;
    if (!Ctor) {
      setVoiceHint(t("chat.voiceUnsupported"));
      window.setTimeout(() => setVoiceHint(null), 3000);
      return;
    }
    try {
      const rec = new Ctor();
      rec.lang = settings.locale === "en" ? "en-US" : "ru-RU";
      rec.interimResults = true;
      rec.continuous = false;
      let finalText = "";
      rec.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result.isFinal) finalText += result[0].transcript;
          else interim += result[0].transcript;
        }
        const next = (finalText + interim).trim();
        setText(next);
        setCursorPos(next.length);
        setComposerMultilineIfNeeded(next.includes("\n"));
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) syncComposerSize(el);
        });
      };
      rec.onend = () => {
        setListening(false);
        recognitionRef.current = null;
        focusComposer();
      };
      rec.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setVoiceHint(t("chat.voiceBlocked"));
          window.setTimeout(() => setVoiceHint(null), 3000);
        }
        setListening(false);
        recognitionRef.current = null;
      };
      recognitionRef.current = rec;
      setListening(true);
      rec.start();
    } catch {
      setVoiceHint(t("chat.voiceUnsupported"));
      window.setTimeout(() => setVoiceHint(null), 3000);
    }
  };

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("acprocess.autoExpandSteps.v2", autoExpandSteps ? "1" : "0");
    } catch {
      // ignore
    }
  }, [autoExpandSteps]);
  const streaming = activeSession?.status === "running" || activeSession?.status === "waiting";

  // MCP servers this chat's agent session runs with: globally enabled minus
  // the ids this chat disabled in its MCP dialog.
  const enabledMcp = (settings.mcpServers ?? []).filter(
    (s) => s.enabled && s.url?.trim(),
  );
  const chatMcp = activeSession
    ? enabledMcp.filter((s) => !(activeSession.mcpDisabledIds ?? []).includes(s.id))
    : [];
  const promptEpoch = useAppStore((s) => s.promptEpoch);
  const cancelledPromptEpoch = useAppStore((s) => s.cancelledPromptEpoch);

  // Notify when a turn finishes while the tab is hidden (skips cancelled turns).
  const prevStreaming = useRef(streaming);
  useEffect(() => {
    const wasStreaming = prevStreaming.current;
    prevStreaming.current = streaming;
    if (!wasStreaming || streaming) return;
    if (cancelledPromptEpoch === promptEpoch) return; // user hit Stop
    if (document.hidden) {
      notifyTurnComplete(activeSession?.title);
    }
  }, [streaming, activeSession?.title, promptEpoch, cancelledPromptEpoch]);

  const planPending = pendingQuestion?.kind === "create_plan";
  const activePlan = useMemo((): PlanPayload | null => {
    if (planPending && pendingQuestion) {
      return coercePlanPayload(pendingQuestion.payload) ?? null;
    }
    return findLatestPlan(activeSession);
  }, [planPending, pendingQuestion, activeSession]);

  const planSignature = useMemo(() => {
    if (!activePlan) return "";
    return [
      activePlan.name ?? "",
      (activePlan.plan ?? "").slice(0, 120),
      String(activePlan.todos?.length ?? 0),
      pendingQuestion?.requestId ?? "",
    ].join("|");
  }, [activePlan, pendingQuestion?.requestId]);

  useEffect(() => {
    if (planPending || planSignature) setPlanPanelOpen(true);
  }, [planPending, pendingQuestion?.requestId, planSignature]);

  useEffect(() => {
    setPlanPanelOpen(false);
  }, [activeSession?.id]);

  const setComposerMultilineIfNeeded = (next: boolean) => {
    composerMultilineRef.current = next;
    setComposerMultiline((prev) => (prev === next ? prev : next));
  };

  const applyComposerHeight = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 160)}px`;
  };

  const syncComposerSize = (el: HTMLTextAreaElement) => {
    const value = el.value;
    // Never poke width — that flicker + single↔multi oscillation is what made the pill "dance".
    el.style.width = "";

    if (!value) {
      el.style.height = "";
      setComposerMultilineIfNeeded(false);
      return;
    }

    const hasNewline = value.includes("\n");
    const pillW = (el.closest(`.${styles.pill}`) as HTMLElement | null)?.clientWidth ?? el.clientWidth;
    const textBudget = Math.max(96, pillW - 230);
    const approxFit = Math.max(8, Math.floor(textBudget / 7.2));
    // Hysteresis: enter early, leave only when clearly short again (no bounce at the edge).
    const enterAt = Math.min(approxFit, 36);
    const exitAt = Math.max(4, Math.floor(enterAt * 0.45));

    if (composerMultilineRef.current) {
      if (!hasNewline && value.length <= exitAt) {
        setComposerMultilineIfNeeded(false);
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          applyComposerHeight(node);
        });
        return;
      }
      applyComposerHeight(el);
      return;
    }

    if (hasNewline) {
      setComposerMultilineIfNeeded(true);
      applyComposerHeight(el);
      return;
    }

    el.style.height = "auto";
    const wrapsNow = el.scrollHeight > 44;
    if (wrapsNow || value.length >= enterAt) {
      setComposerMultilineIfNeeded(true);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        applyComposerHeight(node);
      });
      return;
    }

    applyComposerHeight(el);
  };

  useEffect(() => {
    return () => {
      rememberComposerDraft(composerSessionRef.current, textRef.current);
    };
  }, []);

  useEffect(() => {
    if (composerSessionRef.current === composerSessionId) return;
    rememberComposerDraft(composerSessionRef.current, textRef.current);
    composerSessionRef.current = composerSessionId;
    const next = composerSessionId ? (composerDrafts.get(composerSessionId) ?? "") : "";
    setText(next);
    setCursorPos(next.length);
    setSlashMenuDismissed(false);
    setComposerMultilineIfNeeded(next.includes("\n"));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.setSelectionRange(next.length, next.length);
      syncComposerSize(el);
    });
  }, [composerSessionId]);

  const agentProvider = activeSession?.provider ?? null;
  const agentOffline = Boolean(agentProvider && agentAvailability[agentProvider] === false);
  const noOnlineAgents =
    !agentProvider &&
    !(adapters.length
      ? adapters.some((a) => agentAvailability[a.id] === true)
      : agentAvailability.cursor === true || agentAvailability.omp === true);
  const agentMissing = noOnlineAgents;
  const catalog =
    agentProvider && modelsCatalog?.provider === agentProvider ? modelsCatalog : null;
  const models = catalog?.models ?? [];
  const modelParams = catalog?.modelParams ?? [];
  const modeOptions = agentProvider
    ? sanitizeCatalogModes(agentProvider, catalog?.modes)
    : [];
  const modeSwitcher = modeOptions.length >= 2 ? modeOptions : [];
  const sessionMode = activeSession?.mode ?? settings.defaultMode;
  // Block typing while agent missing, or while models are loading with empty list.
  // Once the agent is already answering, don't keep the composer stuck on "loading models".
  const isEmptyChat = !(activeSession?.messages.some((m) => m.role === "user"));
  // Empty chats stay centered while models/ACP warm up — OMP is slower than Cursor.
  const composerLocked =
    agentMissing ||
    agentOffline ||
    (!isEmptyChat &&
      !!agentProvider &&
      !streaming &&
      !agentOffline &&
      modelsLoading &&
      models.length === 0);

  const slashCommands = useMemo(
    () => mergeSlashCommands(activeSession?.slashCommands, t),
    [activeSession?.slashCommands, t],
  );
  const slashCtx = useMemo(() => getSlashContext(text, cursorPos), [text, cursorPos]);
  const filteredSlashCommands = useMemo(() => {
    if (!slashCtx) return [];
    return filterSlashCommands(slashCommands, slashCtx.query);
  }, [slashCommands, slashCtx]);
  const slashLoading = slashListStillLoading(activeSession?.slashCommands);
  const slashMenuOpen =
    !slashMenuDismissed &&
    !streaming &&
    slashCtx != null &&
    (slashLoading || filteredSlashCommands.length > 0);

  const slashInputHint = useMemo(() => {
    const parsed = parseSlashCommandText(text);
    if (!parsed || parsed.args) return null;
    const cmd = slashCommands.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
    if (!cmd || !slashCommandRequiresInput(cmd)) return null;
    return cmd.inputHint ?? cmd.description;
  }, [text, slashCommands]);

  const insertSlashCommand = (cmd: SlashCommandDto) => {
    const insertion = buildSlashInsertion(cmd);
    const start = slashCtx?.start ?? 0;
    const end = Math.max(cursorPos, start);
    const next = text.slice(0, start) + insertion + text.slice(end);
    const caret = start + insertion.length;
    setText(next);
    setCursorPos(caret);
    setSlashMenuDismissed(true);
    setComposerMultilineIfNeeded(next.includes("\n"));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(caret, caret);
      syncComposerSize(el);
    });
  };

  useEffect(() => {
    setSlashIndex(0);
    setSlashKeyboardNav(false);
    if (slashCtx) setSlashMenuDismissed(false);
  }, [slashCtx?.query, slashCtx?.start]);

  const applySlashCommand = (cmd: SlashCommandDto) => {
    insertSlashCommand(cmd);
  };

  const submitMessage = (raw: string) => {
    const value = raw.trim();
    if (!value || composerLocked) return;
    requestNotificationPermission();
    if (!isSlashCommandReadyToSend(value, slashCommands)) {
      if (shouldAutoFocusComposer()) focusComposer();
      return;
    }
    if (shouldAutoFocusComposer()) {
      keepComposerFocus.current = true;
    } else {
      keepComposerFocus.current = false;
    }
    userJustSentRef.current = true;
    const editId = editingMessageId;
    const attach = editId ? undefined : pendingFiles;
    forgetComposerDraft(composerSessionRef.current);
    setText("");
    setEditingMessageId(null);
    setCursorPos(0);
    setComposerMultilineIfNeeded(false);
    setSlashMenuDismissed(true);
    setPendingFiles([]);
    setAttachError(null);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
    }
    const sendOpts = editId
      ? { editMessageId: editId }
      : attach && attach.length > 0
        ? { attachments: attach }
        : undefined;
    if (shouldAutoFocusComposer()) {
      focusComposer();
      void sendPrompt(value, sendOpts).finally(() => {
        requestAnimationFrame(focusComposer);
        window.setTimeout(focusComposer, 0);
        window.setTimeout(focusComposer, 100);
      });
    } else {
      textareaRef.current?.blur();
      void sendPrompt(value, sendOpts);
    }
  };

  /** Regenerate an assistant reply: resend its user prompt as an edit. */
  const regenerate = (msg: MessageDto) => {
    const messages = activeSession?.messages ?? [];
    const idx = messages.findIndex((m) => m.id === msg.id);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const prev = messages[i];
      if (!prev || prev.role !== "user") continue;
      const value = messagePlainText(prev);
      if (!value.trim()) return;
      // Same housekeeping as submitMessage: clear the composer, resend as an
      // edit (the server truncates the old reply and regenerates it).
      userJustSentRef.current = true;
      forgetComposerDraft(composerSessionRef.current);
      setText("");
      setEditingMessageId(null);
      setCursorPos(0);
      setComposerMultilineIfNeeded(false);
      setSlashMenuDismissed(true);
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
      const send = () => sendPrompt(value, { editMessageId: prev.id });
      if (shouldAutoFocusComposer()) {
        focusComposer();
        send().finally(() => {
          requestAnimationFrame(focusComposer);
          window.setTimeout(focusComposer, 0);
          window.setTimeout(focusComposer, 100);
        });
      } else {
        textareaRef.current?.blur();
        void send();
      }
      return;
    }
  };

  // Deep link ?session=<id>&message=<id> (share links, liked messages):
  // open the chat and jump to the message, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const targetSession = params.get("session");
    const targetMessage = params.get("message");
    if (!targetSession && !targetMessage) return;
    if (targetSession && targetSession !== useAppStore.getState().activeSessionId) {
      void selectSession(targetSession);
    }
    if (targetMessage) setFocusMessageId(targetMessage);
    navigate("/chat", { replace: true });
  }, [search, navigate, selectSession, setFocusMessageId]);

  // Scroll to + highlight the focused message once its session has rendered.
  useEffect(() => {
    if (!focusMessageId) return;
    // In virtual mode the target may be windowed out — bring it into view
    // first, then the DOM poll below finds and highlights it.
    if (chatVirtual) {
      const idx = messageRows.findIndex((r) => r.msg.id === focusMessageId);
      if (idx >= 0) chatVirtualizer.scrollToIndex(idx, { align: "center" });
    }
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const el = document.querySelector(
        `[data-message-id="${CSS.escape(focusMessageId)}"]`,
      );
      if (el) {
        window.clearInterval(timer);
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add(styles.msgFocus);
        window.setTimeout(() => el.classList.remove(styles.msgFocus), 2400);
        setFocusMessageId(null);
      } else if (tries >= 25) {
        window.clearInterval(timer);
        setFocusMessageId(null);
      }
    }, 120);
    return () => window.clearInterval(timer);
  }, [focusMessageId, setFocusMessageId]);

  // Rebuild only when the set of folder paths changes — not on every
  // lastMessageAt bump (tree promote), so the chat pane stays still.
  const recentCwdsKey = useAppStore((s) => {
    const uniq = [
      ...new Set(
        s.sessions
          .map((session) => (session.cwd ?? "").trim())
          .filter(Boolean),
      ),
    ].sort();
    return `${s.settings.defaultCwd ?? ""}\0${s.sessions.length}\0${uniq.join("\0")}`;
  });
  const recentCwds = useMemo(() => {
    const s = useAppStore.getState();
    return collectRecentCwds(s.sessions, s.settings.defaultCwd);
  }, [recentCwdsKey]);
  useEffect(() => {
    if (!agentProvider) return;
    // Soft refresh only — force on every mount (esp. cloudCatalog agents) was
    // rewriting modelsCatalog and bouncing composer state before the first send.
    void useAppStore.getState().loadAdapters().then(() => {
      void ensureModels(agentProvider);
    });
    void api.warmModelParams(agentProvider);
  }, [agentProvider, ensureModels]);

  useEffect(() => {
    if (paramsLoading) return;
    setStableParams(modelParams);
    if (model && modelParams.length) {
      paramsCacheRef.current.set(model, modelParams);
    }
  }, [modelParams, model, paramsLoading]);

  useEffect(() => {
    if (!agentProvider || !model) return;
    if (paramsCacheRef.current.get(model)?.length) return;
    if (modelParams.length) return;
    let cancelled = false;
    void api
      .getModelParams(agentProvider, model, { sessionId: activeSession?.id ?? undefined })
      .then((res) => {
        if (cancelled || !res.modelParams?.length) return;
        paramsCacheRef.current.set(model, res.modelParams);
        setStableParams((prev) => (prev.length ? prev : res.modelParams));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentProvider, model, activeSession?.id, modelParams.length]);

  useEffect(() => {
    const session = activeSession?.provider === agentProvider ? activeSession : null;
    if (!catalog?.models.length) {
      setModel((prev) => {
        const next = modelForSession(settings, session) || "";
        return prev === next ? prev : next;
      });
      setModelParamValues((prev) => {
        const next = modelParamsForSession(settings, session);
        return modelParamsEqual(prev, next) ? prev : next;
      });
      return;
    }
    const preferred = modelForSession(settings, session) || catalog.currentModel || "";
    const nextModel =
      preferred && catalog.models.some((m) => m.value === preferred)
        ? preferred
        : catalog.currentModel || catalog.models[0]?.value || "";
    setModel((prev) => (prev === nextModel ? prev : nextModel));
    const exposed = catalog.modelParams ?? [];
    if (!exposed.length) {
      setModelParamValues((prev) => {
        const next = modelParamsForSession(settings, session);
        return modelParamsEqual(prev, next) ? prev : next;
      });
      return;
    }
    const migrated = migrateModelParamValues(modelParamsForSession(settings, session), exposed);
    const nextParams = Object.keys(migrated).length
      ? migrated
      : Object.fromEntries(
          exposed
            .filter((p) => p.currentValue != null && p.currentValue !== "")
            .map((p) => [p.id, p.currentValue!]),
        );
    setModelParamValues((prev) => (modelParamsEqual(prev, nextParams) ? prev : nextParams));
  }, [
    catalog,
    settings.defaultModel,
    settings.defaultModelParams,
    settings.defaultModelByProvider,
    settings.defaultModelParamsByProvider,
    agentProvider,
    activeSession?.id,
    activeSession?.model,
    activeSession?.modelParams,
  ]);

  const applyModelSelection = async (
    nextModel: string,
    nextParams: Record<string, string>,
  ) => {
    // Alias-aware prune (effort ↔ reasoning). Don't wipe before options load.
    const supported =
      modelParams.length === 0
        ? nextParams
        : migrateModelParamValues(nextParams, modelParams);
    setModel(nextModel);
    setModelParamValues(supported);
    if (!agentProvider) return modelParams;
    if (activeSession?.id) {
      try {
        const res = await api.setSessionModel(activeSession.id, nextModel, supported);
        // Prefer agent-refreshed params, but keep prior Effort if the payload is empty.
        const nextModelParams =
          res.modelParams && res.modelParams.length > 0 ? res.modelParams : modelParams;
        if (res.models?.length || (res.modelParams && res.modelParams.length > 0)) {
          rememberModelsCatalog({
            provider: agentProvider,
            models: res.models?.length ? res.models : models,
            modelParams: nextModelParams,
            // Never keep prior Cursor modes when the agent returns an empty list (OMP).
            modes: res.modes ?? [],
            currentModel: res.currentModel ?? nextModel,
            at: Date.now(),
          });
          setModelParamValues((prev) => migrateModelParamValues(prev, nextModelParams));
          return nextModelParams;
        }
      } catch {
        // settings already saved; live apply optional
      }
    } else {
      const cat = await ensureModels(agentProvider, { force: true });
      return cat?.modelParams ?? modelParams;
    }
    return modelParams;
  };

  const loadParamsForModel = async (nextModel: string) => {
    const cached = paramsCacheRef.current.get(nextModel);
    if (cached?.length) {
      setStableParams(cached);
      return;
    }
    if (nextModel === model) {
      if (modelParams.length) {
        paramsCacheRef.current.set(nextModel, modelParams);
        setStableParams(modelParams);
        return;
      }
      const catParams = catalog?.modelParams ?? [];
      if (catParams.length) {
        paramsCacheRef.current.set(nextModel, catParams);
        setStableParams(catParams);
        return;
      }
    }
    if (!agentProvider) return;
    setParamsLoading(true);
    try {
      const res = await api.getModelParams(agentProvider, nextModel, {
        sessionId: activeSession?.id,
      });
      const committed = res.modelParams?.length ? res.modelParams : [];
      paramsCacheRef.current.set(nextModel, committed);
      setStableParams(committed);
      if (committed.length && nextModel === model) {
        rememberModelsCatalog({
          provider: agentProvider,
          models,
          modelParams: committed,
          modes: catalog?.modes ?? [],
          currentModel: model,
          at: Date.now(),
        });
      }
    } finally {
      setParamsLoading(false);
    }
  };

  const onModelChange = async (value: string) => {
    // Don't carry Fast/Effort from the previous model — they often aren't valid
    // for the new one and used to leave the ACP session broken.
    await applyModelSelection(value, {});
  };

  const modeLabel = (value: string, fallback?: string) => {
    if (value === "agent") return t("modes.agent");
    if (value === "plan") return t("modes.plan");
    if (value === "ask") return t("modes.ask");
    return (fallback || value).trim() || value;
  };

  const onModeChange = async (nextMode: string) => {
    if (nextMode !== "agent" && nextMode !== "plan" && nextMode !== "ask") return;
    const mode = nextMode as AgentMode;
    if (mode === sessionMode) return;

    const sessionId = activeSession?.id ?? null;
    const prevMode = sessionMode;
    const prevSettingsMode = settings.defaultMode;

    // Show the new mode immediately — ACP sync can take seconds.
    useAppStore.setState((s) => ({
      settings: { ...s.settings, defaultMode: mode },
      sessions: sessionId
        ? s.sessions.map((row) => (row.id === sessionId ? { ...row, mode } : row))
        : s.sessions,
      activeSession:
        sessionId && s.activeSession?.id === sessionId
          ? { ...s.activeSession, mode }
          : s.activeSession,
    }));

    try {
      if (sessionId) {
        const res = await api.setSessionMode(sessionId, mode);
        if (res.session) {
          useAppStore.setState((s) => ({
            settings: { ...s.settings, defaultMode: mode },
            sessions: s.sessions.map((row) => (row.id === res.session!.id ? res.session! : row)),
            activeSession:
              s.activeSession?.id === res.session!.id
                ? { ...s.activeSession, ...res.session!, mode: res.session!.mode ?? mode }
                : s.activeSession,
          }));
        }
      } else {
        await saveSettings({ defaultMode: mode });
      }
    } catch (err) {
      useAppStore.setState((s) => ({
        error: err instanceof Error ? err.message : String(err),
        settings: { ...s.settings, defaultMode: prevSettingsMode },
        sessions: sessionId
          ? s.sessions.map((row) => (row.id === sessionId ? { ...row, mode: prevMode } : row))
          : s.sessions,
        activeSession:
          sessionId && s.activeSession?.id === sessionId
            ? { ...s.activeSession, mode: prevMode }
            : s.activeSession,
      }));
    }
  };

  const onParamsChange = async (next: Record<string, string>) => {
    const fresh = await applyModelSelection(model, next);
    if (fresh?.length) {
      paramsCacheRef.current.set(model, fresh);
      setStableParams(fresh);
    }
  };

  const focusComposer = () => {
    if (!shouldAutoFocusComposer()) return;
    const el = textareaRef.current;
    if (!el) return;
    if (document.activeElement !== el) {
      el.focus({ preventScroll: true });
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // ignore
      }
    }
    // Don't syncComposerSize here during stream — height thrash makes the thread jump.
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (el) syncComposerSize(el);
  }, [text]);

  useEffect(() => {
    if (streaming) {
      // Keep focus if the user is typing, but never yank the caret into the
      // input just because a stream started (queued turns chain streams and
      // would otherwise flash a blinking cursor on every new reply).
      keepComposerFocus.current = shouldAutoFocusComposer();
      return;
    }
    const t = window.setTimeout(() => {
      keepComposerFocus.current = false;
    }, 300);
    return () => window.clearTimeout(t);
  }, [streaming]);

  const lastMessageId = activeSession?.messages.at(-1)?.id;
  const messageCount = activeSession?.messages.length ?? 0;

  const emptyReady = Boolean(activeSession) && isEmptyChat && !restoring;
  const restoringEmpty = Boolean(activeSession) && !renderSkeleton && isEmptyChat && restoring;
  // Loading windows (skeleton, session creation, boot) keep the composer out
  // of the layout so an empty chat's input never renders at the bottom and
  // then jumps to center — it appears in its final position once ready. The
  // first-run welcome state (no sessions at all) keeps its composer.
  const composerHeld =
    renderSkeleton || (!activeSession && (sessionLoading || loading || hasSessions));
  const showThreadSkeleton = composerHeld;
  // Each user message starts a new turn segment (one request + its replies) —
  // with multitask on, segments get distinct cards so concurrent requests
  // read as separate workspaces instead of one interleaved feed.
  const segments = useMemo(() => {
    const msgs = activeSession?.messages ?? [];
    const out: MessageDto[][] = [];
    let current: MessageDto[] = [];
    for (const m of msgs) {
      if (m.role === "user" && current.length > 0) {
        out.push(current);
        current = [];
      }
      current.push(m);
    }
    if (current.length > 0) out.push(current);
    return out;
  }, [activeSession?.messages]);

  // ── Message virtualization ────────────────────────────────────────────────
  // Beyond a threshold the flat message feed is windowed with
  // @tanstack/react-virtual; small feeds keep the plain render untouched.
  const messageRows = useMemo(
    () =>
      segments.flatMap((segment, segIndex) =>
        segment
          .filter(
            (m) =>
              m.role !== "assistant" || hasRenderableAssistantContent(m.parts) || m.id === lastMessageId,
          )
          .map((msg, idx) => ({
            msg,
            segStart: idx === 0,
            showDivider:
              settings.multitask && inflight >= 2 && segIndex === segments.length - 1 && idx === 0,
          })),
      ),
    [segments, settings.multitask, inflight, lastMessageId],
  );
  // Window sooner than the tree: reply messages can be huge (long texts, many
  // tool parts), so a session with a few dozen messages is already expensive.
  // Trigger on message count OR estimated total height (~px, from the same
  // heuristic the virtualizer seeds unmeasured rows with).
  const CHAT_VIRT_MIN_MESSAGES = 25;
  const CHAT_VIRT_MAX_ESTIMATED_PX = 8000;
  const chatVirtual =
    messageRows.length > CHAT_VIRT_MIN_MESSAGES ||
    messageRows.reduce((acc, r) => acc + estimateMessageRowHeight(r.msg), 0) >
      CHAT_VIRT_MAX_ESTIMATED_PX;
  const chatVirtualizer = useVirtualizer({
    count: chatVirtual ? messageRows.length : 0,
    getScrollElement: () => threadRef.current,
    estimateSize: (index) => estimateMessageRowHeight(messageRows[index]?.msg),
    overscan: 6,
    // Glue the viewport to the true bottom: when near the end, any measured
    // height delta (estimate→actual, streaming growth) shifts the scroll by
    // exactly that delta, so the landing converges to the real bottom even
    // when the last reply measures far taller than its estimate.
    anchorTo: "end",
    // New messages while at the end auto-scroll to the bottom.
    followOnAppend: true,
  });

  const renderArticle = (msg: MessageDto, isLiveAssistant: boolean) => {
    if (msg.role === "assistant" && !hasRenderableAssistantContent(msg.parts) && !isLiveAssistant) {
      return null;
    }
    return (
      <MessageArticle
        key={msg.id}
        msg={msg}
        isLiveAssistant={isLiveAssistant}
        onEditUser={(messageId, value) => {
          setEditingMessageId(messageId);
          setText(value);
          window.requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.focus();
            syncComposerSize(el);
            const end = value.length;
            el.setSelectionRange(end, end);
          });
        }}
        onRegenerate={() => regenerate(msg)}
        activeSession={activeSession}
        autoExpandSteps={autoExpandSteps}
        stepsGlobalTick={stepsGlobalTick}
        keepComposerFocus={keepComposerFocus}
        textareaRef={textareaRef}
      />
    );
  };

  const renderMessageRow = (row: (typeof messageRows)[number]) => (
    <Fragment key={row.msg.id}>
      {row.showDivider ? (
        <div className={styles.turnDivider} aria-hidden>
          <span className={styles.turnDividerLabel}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <path
                d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinejoin="round"
              />
            </svg>
            {t("chat.parallelTurn")}
          </span>
        </div>
      ) : null}
      {renderArticle(row.msg, streaming && row.msg.role === "assistant" && row.msg.id === lastMessageId)}
    </Fragment>
  );
  const activeSessionId = activeSession?.id ?? null;
  const streamDigest = useMemo(() => {
    if (!activeSession?.messages.length) return `${activeSession?.status ?? ""}`;
    let parts = 0;
    let chars = 0;
    for (const m of activeSession.messages) {
      parts += m.parts.length;
      for (const p of m.parts) {
        const text = p.payload?.text;
        if (typeof text === "string") chars += text.length;
        const message = p.payload?.message;
        if (typeof message === "string") chars += message.length;
      }
    }
    return `${parts}:${chars}:${activeSession.status}`;
  }, [activeSession?.messages, activeSession?.status]);
  const contextUsage = useMemo(
    () => estimateContextUsage(activeSession?.messages ?? []),
    [activeSession?.messages],
  );
  const contextDisplay = useMemo(() => {
    const acp = activeSession?.usage ?? null;
    const used = acp?.usedTokens;
    const win = acp?.contextWindow;
    const cost = acp?.cost;
    const label =
      used != null
        ? win != null
          ? `${formatCompact(used)} / ${formatCompact(win)}`
          : `${formatCompact(used)} ${t("chat.contextUnit")}`
        : `${formatCompact(contextUsage.tokens)} ${t("chat.contextUnit")}`;
    const title = acp
      ? t("chat.contextAcpTooltip", {
          used: (used ?? 0).toLocaleString(),
          window: (win ?? 0).toLocaleString(),
          cost: cost != null ? cost.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—",
        })
      : t("chat.contextTooltip", {
          tokens: contextUsage.tokens.toLocaleString(),
          chars: contextUsage.chars.toLocaleString(),
        });
    return { label, title };
  }, [activeSession?.usage, contextUsage, t]);

  const prevSessionIdRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const suppressScrollWatchRef = useRef(false);
  /** Pin to bottom across skeleton → first paint of an unloaded chat. */
  const pendingBottomPinRef = useRef(false);
  const [scrolledAway, setScrolledAway] = useState(false);
  const scrollRafRef = useRef(0);
  const threadInnerRef = useRef<HTMLDivElement>(null);

  const scrollThreadToEnd = () => {
    const thread = threadRef.current;
    if (!thread) return;
    suppressScrollWatchRef.current = true;
    stickToBottomRef.current = true;
    setScrolledAway(false);
    thread.scrollTop = thread.scrollHeight;
    window.requestAnimationFrame(() => {
      const node = threadRef.current;
      if (node) node.scrollTop = node.scrollHeight;
      suppressScrollWatchRef.current = false;
      stickToBottomRef.current = true;
    });
  };

  const scheduleScrollToEnd = () => {
    if (!stickToBottomRef.current && !userJustSentRef.current && !pendingBottomPinRef.current) {
      return;
    }
    if (scrollRafRef.current) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      if (stickToBottomRef.current || userJustSentRef.current || pendingBottomPinRef.current) {
        scrollThreadToEnd();
      }
    });
  };

  // The queue bar pushes the composer down and can cover the last messages —
  // jump to the very bottom whenever a new item is queued.
  const prevQueueLenRef = useRef(0);
  useEffect(() => {
    if (promptQueue.length > prevQueueLenRef.current) {
      scrollThreadToEnd();
    }
    prevQueueLenRef.current = promptQueue.length;
  }, [promptQueue.length]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const onScroll = () => {
      if (suppressScrollWatchRef.current) return;
      // While pinning a freshly opened chat, ignore intermediate layouts that
      // look like "scrolled away" (skeleton → content height jumps).
      if (pendingBottomPinRef.current) {
        stickToBottomRef.current = true;
        setScrolledAway(false);
        return;
      }
      // Growth during stream can temporarily look like "scrolled away" before we catch up.
      const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      const stuck = gap < 140;
      stickToBottomRef.current = stuck;
      setScrolledAway(!stuck);
    };
    thread.addEventListener("scroll", onScroll, { passive: true });
    return () => thread.removeEventListener("scroll", onScroll);
  }, [storeActiveSessionId]);

  useEffect(() => {
    const inner = threadInnerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current || userJustSentRef.current || pendingBottomPinRef.current) {
        scrollThreadToEnd();
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [storeActiveSessionId, renderSkeleton]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) window.cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // Mark a bottom-pin whenever the store switches chats (often before detail arrives).
  useLayoutEffect(() => {
    if (storeActiveSessionId === prevSessionIdRef.current) return;
    prevSessionIdRef.current = storeActiveSessionId;
    stickToBottomRef.current = true;
    userJustSentRef.current = false;
    pendingBottomPinRef.current = Boolean(storeActiveSessionId);
    if (!shouldAutoFocusComposer()) {
      textareaRef.current?.blur();
    } else if (keepComposerFocus.current) {
      focusComposer();
    }
  }, [storeActiveSessionId]);

  // Snap to bottom once the thread is actually painted (after skeleton), and
  // keep pinning through the first content/layout settles.
  useLayoutEffect(() => {
    if (!pendingBottomPinRef.current) return;
    if (renderSkeleton) return;
    if (!storeActiveSessionId) {
      pendingBottomPinRef.current = false;
      return;
    }
    if (isEmptyChat) {
      pendingBottomPinRef.current = false;
      return;
    }
    // Detail for another chat may still be on screen while the new id loads.
    if (activeSession && activeSession.id !== storeActiveSessionId) return;

    scrollThreadToEnd();
    const raf = window.requestAnimationFrame(() => scrollThreadToEnd());
    const t1 = window.setTimeout(() => scrollThreadToEnd(), 0);
    const t2 = window.setTimeout(() => {
      scrollThreadToEnd();
      pendingBottomPinRef.current = false;
    }, 120);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [
    renderSkeleton,
    storeActiveSessionId,
    activeSessionId,
    messageCount,
    lastMessageId,
    streamDigest,
    isEmptyChat,
  ]);

  // Snap on send, stream tokens, and permission prompts.
  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    if (pendingBottomPinRef.current) return;
    const promptId =
      pendingPermission?.requestId ?? pendingQuestion?.requestId ?? null;
    if (userJustSentRef.current || promptId) {
      stickToBottomRef.current = true;
      userJustSentRef.current = false;
      scrollThreadToEnd();
      return;
    }
    // Follow while streaming — but only when the user is already at the
    // bottom; scrolled-away readers keep their place while thoughts grow.
    if (streaming) {
      if (stickToBottomRef.current) scrollThreadToEnd();
      return;
    }
    if (!stickToBottomRef.current) return;
    scheduleScrollToEnd();
  }, [
    lastMessageId,
    messageCount,
    streamDigest,
    streaming,
    pendingPermission?.requestId,
    pendingQuestion?.requestId,
  ]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const onFocusIn = (e: FocusEvent) => {
      if (!shouldAutoFocusComposer() || !keepComposerFocus.current) return;
      const target = e.target as HTMLElement | null;
      if (!target || target === textareaRef.current) return;
      // Don't steal focus from permission / question actions or other controls in the thread.
      if (
        target.closest(
          "button, a, input, textarea, select, [role='button'], [role='option'], [role='menuitem']",
        )
      ) {
        return;
      }
      if (thread.contains(target)) {
        focusComposer();
      }
    };
    thread.addEventListener("focusin", onFocusIn);
    return () => thread.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    return () => {
      keepComposerFocus.current = false;
      textareaRef.current?.blur();
    };
  }, []);

  const focusChatPane = useAppStore((s) => s.focusChatPane);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitMessage(text);
  };

  return (
    <div
      className={`${styles.page} ${planPanelOpen && activePlan ? styles.pageWithPlan : ""} ${
        consoleOpen ? styles.pageWithConsole : ""
      } ${bind && bind.paneCount > 1 ? styles.pageInSplit : ""}`}
      onPointerDown={() => {
        if (bind && !bind.focused) focusChatPane(bind.paneIndex);
      }}
    >
      <div className={`${styles.mainColumn}${emptyReady || restoringEmpty ? ` ${styles.mainColumnEmptyReady}` : ""}`}>
      <div className={styles.thread} ref={threadRef}>
        {showThreadSkeleton ? (
          <div className={styles.threadSkeleton} role="status" aria-label={t("chat.loadingChat")}>
            <div className={styles.skeletonTurn}>
              <div className={styles.skeletonLine} style={{ "--w": "64%" } as CSSProperties} />
              <div className={styles.skeletonLine} style={{ "--w": "86%" } as CSSProperties} />
              <div className={styles.skeletonLine} style={{ "--w": "48%" } as CSSProperties} />
            </div>
            <div className={`${styles.skeletonTurn} ${styles.skeletonTurnUser}`}>
              <div className={styles.skeletonBubble} style={{ "--w": "46%" } as CSSProperties} />
            </div>
            <div className={styles.skeletonTurn}>
              <div className={styles.skeletonLine} style={{ "--w": "58%" } as CSSProperties} />
              <div className={styles.skeletonLine} style={{ "--w": "74%" } as CSSProperties} />
            </div>
            <div className={`${styles.skeletonTurn} ${styles.skeletonTurnUser}`}>
              <div className={styles.skeletonBubble} style={{ "--w": "34%" } as CSSProperties} />
            </div>
            <div className={styles.skeletonTurn}>
              <div className={styles.skeletonLine} style={{ "--w": "70%" } as CSSProperties} />
              <div className={styles.skeletonLine} style={{ "--w": "52%" } as CSSProperties} />
            </div>
            <div className={`${styles.skeletonTurn} ${styles.skeletonTurnUser}`}>
              <div className={styles.skeletonBubble} style={{ "--w": "40%" } as CSSProperties} />
            </div>
            <div className={styles.skeletonTurn}>
              <div className={styles.skeletonLine} style={{ "--w": "60%" } as CSSProperties} />
              <div className={styles.skeletonLine} style={{ "--w": "80%" } as CSSProperties} />
            </div>
          </div>
        ) : (
        <div key={activeSession?.id ?? "empty"} className={styles.threadInner} ref={threadInnerRef}>

        {!activeSession && !sessionLoading && !loading && !hasSessions && (
          <div className={styles.empty}>
            <h1>
              <span>ACP</span>rocess
            </h1>
            <p>{t("chat.emptyDescription")}</p>
            {agentMissing ? <p>{t("common.noAgentsOnline")}</p> : null}
            <div className={styles.emptyActions}>
              {!agentMissing ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                      setFolderPicker({ x: rect.left, y: rect.bottom + 8 });
                    }}
                  >
                    {t("chat.newSession")}
                  </button>
                  <Link
                    className={styles.secondary}
                    to="/settings"
                    style={{ display: "inline-flex", alignItems: "center" }}
                  >
                    {t("common.settings")}
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        )}

        {chatVirtual ? (
          <div
            style={{
              height: chatVirtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
              // Absolute children contribute no content height, so the flex
              // column would shrink this container and cap the scroll area.
              flexShrink: 0,
            }}
          >
            {chatVirtualizer.getVirtualItems().map((vi) => {
              const row = messageRows[vi.index];
              if (!row) return null;
              // Keep the tight user→assistant pairing the plain feed has
              // (.msg.user + .msg.assistant { margin-top: -7px }) — the pull-up
              // stays inside the previous row's padding zone.
              const tight =
                row.msg.role === "assistant" &&
                messageRows[vi.index - 1]?.msg.role === "user";
              return (
                <div
                  key={row.msg.id}
                  data-index={vi.index}
                  ref={chatVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                    paddingBottom: 12,
                  }}
                >
                  {tight ? (
                    <div style={{ marginTop: -7 }}>{renderMessageRow(row)}</div>
                  ) : (
                    renderMessageRow(row)
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {segments.map((segment, segIndex) => (
              <Fragment key={segment[0]?.id ?? `seg-${segIndex}`}>
                {settings.multitask && inflight >= 2 && segIndex === segments.length - 1 && (
                  <div className={styles.turnDivider} aria-hidden>
                    <span className={styles.turnDividerLabel}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {t("chat.parallelTurn")}
                    </span>
                  </div>
                )}
                <div className={styles.turnSegment}>
                  {segment.map((msg, index) => {
                    const globalIndex =
                      activeSession?.messages.findIndex((m) => m.id === msg.id) ?? index;
                    const isLiveAssistant =
                      streaming &&
                      msg.role === "assistant" &&
                      globalIndex === (activeSession?.messages.length ?? 0) - 1;
                    return renderArticle(msg, isLiveAssistant);
                  })}
                </div>
              </Fragment>
            ))}
          </>
        )}
        <div ref={messageEndRef} className={styles.threadEnd} aria-hidden />
        </div>
        )}
      </div>

      {(pendingPermission || pendingQuestion) &&
      (!pendingPermission || pendingPermission.sessionId === activeSession?.id) &&
      (!pendingQuestion || pendingQuestion.sessionId === activeSession?.id) ? (
        <div className={styles.inlinePromptDock}>
          <ChatInlinePrompt onOpenPlan={() => setPlanPanelOpen(true)} />
        </div>
      ) : null}

      {error && <div className={styles.banner}>{error}</div>}

      {promptQueue.length > 0 && (
        <div className={styles.queueBar}>
          <div className={styles.queueBarHeader}>
            <span className={styles.queueBarTitle}>{t("chat.promptQueue")}</span>
            <span className={styles.queueBarCount}>
              {t("chat.queueCount", { count: promptQueue.length })}
            </span>
          </div>
          <div className={styles.queueList}>
            {promptQueue.map((item) => (
              <div key={item.id} className={styles.queueItem}>
                <span className={styles.queueItemText} title={item.text}>
                  {item.text}
                </span>
                <button
                  type="button"
                  className={styles.queueItemBtn}
                  title={t("common.edit")}
                  aria-label={t("common.edit")}
                  onClick={() => {
                    // Pull the text back into the composer for editing.
                    removeQueuedPrompt(item.id);
                    setText(item.text);
                    setCursorPos(item.text.length);
                    setComposerMultilineIfNeeded(item.text.includes("\n"));
                    requestAnimationFrame(() => {
                      const el = textareaRef.current;
                      if (!el) return;
                      el.focus({ preventScroll: true });
                      el.setSelectionRange(item.text.length, item.text.length);
                      syncComposerSize(el);
                    });
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M4 20h4.8L20 8.8 15.2 4 4 15.2V20Z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M12.8 6.8 17.2 11.2"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <form
        className={`${styles.composer}${composerHeld ? ` ${styles.composerSkeleton}` : ""}${
          emptyReady || restoringEmpty ? ` ${styles.composerEmptyReady}` : ""
        }`}
        onSubmit={onSubmit}
      >
        {scrolledAway && activeSession && !emptyReady && !restoringEmpty ? (
          <button
            type="button"
            className={styles.jumpLatest}
            onPointerDown={(e) => {
              // Act on the press, not the release: the button floats over the
              // scroll area, so the synthesized mouse/click events can land on
              // the thread content beneath it (especially the left part after
              // the composer shifts focus). pointerdown carries the correct
              // target; preventDefault also suppresses the compat mouse events.
              e.preventDefault();
              scrollThreadToEnd();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 4v14m0 0 5-5m-5 5-5-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className={styles.jumpLatestLabel}>{t("chat.jumpToLatest")}</span>
          </button>
        ) : null}
        <div className={styles.composerInner}>
          {restoringEmpty ? (
            <p className={styles.emptyReadyLead}>{t("chat.sessionRestoring")}</p>
          ) : emptyReady ? (
            <p className={styles.emptyReadyLead}>{t("chat.emptyReady")}</p>
          ) : null}
          <div className={styles.composerStatusSlot} aria-live="polite">
            {editingMessageId && (
              <div className={styles.typingBar}>
                <span>{t("chat.editingMessage")}</span>
                <button
                  type="button"
                  className={styles.editCancel}
                  onClick={() => {
                    setEditingMessageId(null);
                    forgetComposerDraft(composerSessionRef.current);
                    setText("");
                    setComposerMultilineIfNeeded(false);
                  }}
                >
                  {t("common.cancel")}
                </button>
              </div>
            )}
            {!editingMessageId && agentOffline && (
              <div className={styles.typingBar}>{t("common.thisChatAgentOffline")}</div>
            )}
            {!editingMessageId && agentMissing && (
              <div className={styles.typingBar}>{t("common.noAgentsOnline")}</div>
            )}
            {!editingMessageId && !agentMissing && !agentOffline && activeSession?.status === "waiting" && (
              <div className={styles.typingBar}>{t("common.waitingInput")}</div>
            )}
            {!editingMessageId &&
              !agentMissing &&
              !agentOffline &&
              composerLocked &&
              !streaming && (
                <div className={styles.typingBar}>
                  <span className={styles.modelsLoaderSpin} aria-hidden />
                  <span>{t("common.loadingModels")}</span>
                </div>
              )}
          </div>
          <ComposerMetaChips
            renderSkeleton={renderSkeleton}
            settings={settings}
            activeSession={activeSession}
            autoExpandSteps={autoExpandSteps}
            onToggleAutoExpandSteps={() => syncAutoExpandSteps(!autoExpandSteps)}
            chatMcp={chatMcp}
            enabledMcpCount={enabledMcp.length}
            contextDisplay={contextDisplay}
            consoleOpen={consoleOpen}
            onToggleConsole={() => toggleConsoleOpen()}
            consoleLive={consoleLive}
            modeSwitcher={modeSwitcher}
            sessionMode={sessionMode}
            composerLocked={composerLocked}
            onModeChange={onModeChange}
            onOpenMcpDialog={() => setMcpDialogOpen(true)}
            modeLabel={modeLabel}
          />
          {(pendingFiles.length > 0 || attachError) && (
            <div className={styles.pendingFiles}>
              {attachError ? <span className={styles.attachError}>{attachError}</span> : null}
              {pendingFiles.map((f, i) => (
                <span key={`${f.name}-${i}`} className={styles.pendingFileChip}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className={styles.pendingFileMeta}>
                    <span className={styles.pendingFileName}>{f.name}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.pendingFileRemove}
                    aria-label={t("chat.removeFile")}
                    title={t("chat.removeFile")}
                    onClick={() =>
                      setPendingFiles((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div
            className={`${styles.pill} ${composerMultiline ? styles.pillMultiline : ""} ${
              streaming ? styles.pillBusy : ""
            } ${composerLocked ? styles.pillLoading : ""}`}
          >
            <SlashCommandMenu
              open={slashMenuOpen}
              preferAbove
              loading={slashLoading && slashCtx != null}
              loadingLabel={t("common.slashCommandsLoading")}
              commands={filteredSlashCommands}
              activeIndex={slashIndex}
              scrollActiveIntoView={slashKeyboardNav}
              anchorRef={textareaRef}
              onSelect={applySlashCommand}
              onActiveIndexChange={(idx) => {
                setSlashKeyboardNav(false);
                setSlashIndex(idx);
              }}
            />
            <div className={styles.pillInputWrap}>
              {text ? (
                <div className={styles.pillInputHighlight} aria-hidden>
                  <div ref={composerHighlightInnerRef} className={styles.pillInputHighlightInner}>
                    {highlightUserText(
                      text,
                      slashCommands.map((c) => c.name),
                    )}
                    {"\u200b"}
                  </div>
                </div>
              ) : null}
              <textarea
              ref={textareaRef}
              className={`${styles.pillInput}${text ? ` ${styles.pillInputGhost}` : ""}`}
              value={text}
              onChange={(e) => {
                if (composerLocked) return;
                setText(e.target.value);
                setCursorPos(e.target.selectionStart);
                syncComposerSize(e.currentTarget);
              }}
              onScroll={(e) => {
                const inner = composerHighlightInnerRef.current;
                if (inner) inner.style.transform = `translateY(-${e.currentTarget.scrollTop}px)`;
              }}
              onBlur={(e) => {
                const next = e.relatedTarget instanceof Element ? e.relatedTarget : null;
                if (next?.closest('[role="listbox"]')) return;
                setSlashMenuDismissed(true);
              }}
              onClick={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart)}
              placeholder={
                slashInputHint ??
                (composerLocked && !agentMissing && !agentOffline
                  ? t("common.loadingModels")
                  : t("common.messageOrCommand"))
              }
              rows={1}
              disabled={composerLocked}
              readOnly={composerLocked}
              aria-busy={composerLocked || undefined}
              onKeyDown={(e) => {
                if (composerLocked) {
                  e.preventDefault();
                  return;
                }
                if (slashMenuOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashKeyboardNav(true);
                    setSlashIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashKeyboardNav(true);
                    setSlashIndex((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (e.key === "Tab" || e.key === "Enter") {
                    e.preventDefault();
                    const cmd = filteredSlashCommands[slashIndex];
                    if (cmd) applySlashCommand(cmd);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashMenuDismissed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  // Enter-to-send (default): Enter submits, Ctrl/Shift+Enter
                  // is a newline. Off: Enter inserts a newline and Ctrl+Enter
                  // submits.
                  const submitKey =
                    settings.chatEnterToSend !== false
                      ? !e.ctrlKey && !e.metaKey
                      : e.ctrlKey || e.metaKey;
                  if (submitKey) {
                    e.preventDefault();
                    onSubmit(e);
                  }
                }
              }}
            />
            </div>

            <div className={styles.pillFooter}>
              {(settings.chatComposerButtons ?? []).includes("attach") && (
              <button
                type="button"
                className={styles.attachBtn}
                aria-label={t("chat.attachFiles")}
                title={t("chat.attachFiles")}
                disabled={composerLocked || editingMessageId !== null || streaming}
                onClick={() => setAttachDialogOpen(true)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              )}

              {voiceHint && <span className={styles.voiceHint}>{voiceHint}</span>}

              <div className={styles.pillFooterEnd}>
                {(settings.chatComposerButtons ?? []).includes("model") && (
                <ModelPicker
                  className={styles.composerModel}
                  model={model}
                  models={models}
                  params={stableParams}
                  paramValues={modelParamValues}
                  paramsLoading={paramsLoading}
                  loading={composerLocked || modelsLoading}
                  disabled={agentMissing || agentOffline}
                  onOpen={() => {
                    if (!agentProvider) return;
                    void api.warmModelParams(agentProvider);
                    const cached = useAppStore.getState().modelsCatalog;
                    const needsCatalog =
                      !cached ||
                      cached.provider !== agentProvider ||
                      (cached.models?.length ?? 0) === 0;
                    void ensureModels(agentProvider, { force: needsCatalog });
                    if (model) {
                      void api.getModelParams(agentProvider, model, {
                        sessionId: activeSession?.id,
                      }).then((res) => {
                        if (!res.modelParams?.length) return;
                        paramsCacheRef.current.set(model, res.modelParams);
                        setStableParams((prev) => (prev.length ? prev : res.modelParams));
                      });
                    }
                  }}
                  onChange={(v) => void onModelChange(v)}
                  onParamsOpen={(v) => loadParamsForModel(v)}
                  onParamsChange={(next) => void onParamsChange(next)}
                />
                )}

                {streaming ? (
                  <button
                    type="button"
                    className={styles.stopBtn}
                    title={t("common.stop")}
                    aria-label={t("common.stop")}
                    onClick={() => void cancelPrompt()}
                  >
                    <svg className={styles.stopIcon} width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <rect x="4" y="4" width="16" height="16" rx="2.5" />
                    </svg>
                  </button>
                ) : (
                  <>
                    {(settings.chatComposerButtons ?? []).includes("mic") && (
                    <button
                      type="button"
                      className={`${styles.micBtn} ${
                        hasText ? styles.micBtnGhost : styles.micBtnSendSlot
                      }${listening ? ` ${styles.micBtnActive}` : ""}`}
                      title={listening ? t("chat.voiceListening") : t("chat.voiceInput")}
                      aria-label={listening ? t("chat.voiceListening") : t("chat.voiceInput")}
                      aria-pressed={listening}
                      disabled={composerLocked || !voiceSupported}
                      onClick={toggleVoiceInput}
                    >
                      <svg
                        className={hasText ? styles.micIconStroke : undefined}
                        width="17"
                        height="17"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden
                      >
                        <rect
                          x="9"
                          y="3"
                          width="6"
                          height="11"
                          rx="3"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        />
                        <path
                          d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                    )}
                    {hasText && (
                      <button
                        type="submit"
                        className={styles.sendBtn}
                        disabled={composerLocked || !text.trim()}
                        title={
                          agentMissing
                            ? t("common.noAgentsOnline")
                            : agentOffline
                              ? t("common.thisChatAgentOffline")
                            : composerLocked
                              ? t("common.loadingModels")
                              : t("common.send")
                        }
                        aria-label={t("common.send")}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path
                            d="M12 19V5M12 5l-6 6M12 5l6 6"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </form>

      {folderPicker && (
        <CreateSessionFolderPicker
          x={folderPicker.x}
          y={folderPicker.y}
          defaultCwd={settings.defaultCwd ?? ""}
          recentCwds={recentCwds}
          agents={(adapters.length
            ? adapters.map((a) => ({ id: a.id, label: a.label }))
            : [
                { id: "cursor" as const, label: "Cursor" },
                { id: "omp" as const, label: "OMP" },
              ]
          ).map((a) => ({ ...a, online: agentAvailability[a.id] === true }))}
          preferredProvider={settings.defaultProvider}
          onClose={() => setFolderPicker(null)}
          onConfirm={async (cwd, provider) => {
            setFolderPicker(null);
            try {
              await createSession(cwd, provider);
              if (shouldAutoFocusComposer()) focusComposer();
            } catch (err) {
              showToast(
                err instanceof Error && err.message === "noAgentsOnline"
                  ? t("common.noAgentsOnline")
                  : err instanceof Error
                    ? err.message
                    : String(err),
                { tone: "danger" },
              );
            }
          }}
          onOpenExisting={async (row) => {
            setFolderPicker(null);
            try {
              await importHarnessSession({
                provider: row.provider,
                acpSessionId: row.acpSessionId,
                cwd: row.cwd,
                title: row.title,
              });
              if (shouldAutoFocusComposer()) focusComposer();
            } catch (err) {
              showToast(
                err instanceof Error && err.message === "alreadyInTree"
                  ? t("chat.alreadyInTree")
                  : err instanceof Error
                    ? err.message
                    : String(err),
                { tone: "danger" },
              );
            }
          }}
        />
      )}
      <AttachDialog
        open={attachDialogOpen}
        initialDir={activeSession?.cwd}
        onClose={() => setAttachDialogOpen(false)}
        onAttach={(files) => {
          setPendingFiles((prev) => {
            if (prev.length + files.length > 8) {
              setAttachError(t("chat.tooManyFiles"));
              return prev;
            }
            setAttachError(null);
            return [...prev, ...files];
          });
        }}
      />
      <McpChatDialog
        open={mcpDialogOpen}
        sessionId={activeSession?.id ?? null}
        mcpDisabledIds={activeSession?.mcpDisabledIds}
        onClose={() => setMcpDialogOpen(false)}
      />
      </div>

      {(!bind || bind.focused) && speakingMessageId && (
        <button
          type="button"
          className={styles.ttsStopFab}
          title={ttsLoading ? t("chat.ttsGenerating") : t("chat.stopReading")}
          aria-label={ttsLoading ? t("chat.ttsGenerating") : t("chat.stopReading")}
          onClick={() => stopReadAloud()}
        >
          {ttsLoading ? (
            <span className={styles.ttsStopSpin} aria-hidden />
          ) : (
            <span className={styles.ttsStopBars} aria-hidden>
              <span />
              <span />
              <span />
              <span />
            </span>
          )}
        </button>
      )}
      {(!bind || bind.focused) && (
        <>
      {activeSession ? (
        <ConsoleSidePanel
          sessionId={activeSession.id}
          open={consoleOpen && (!bind || bind.focused)}
          live={consoleLive}
          onClose={() => setConsoleOpen(false)}
        />
      ) : null}
      <PlanTabButton
        visible={Boolean(activePlan) && !planPanelOpen}
        open={planPanelOpen}
        pending={planPending}
        onClick={() => setPlanPanelOpen(true)}
      />
        </>
      )}
      <PlanSidePanel
        plan={activePlan}
        open={planPanelOpen && (!bind || bind.focused)}
        pending={planPending}
        onClose={() => setPlanPanelOpen(false)}
        onAccept={
          planPending
            ? () => void answerQuestion({ outcome: { outcome: "accepted" } })
            : undefined
        }
        onReject={
          planPending
            ? () =>
                void answerQuestion({
                  outcome: { outcome: "rejected", reason: "rejected by user" },
                })
            : undefined
        }
      />
    </div>
  );
}

function SplitToggleFab({ enabled }: { enabled: boolean }) {
  const t = useT();
  const count = useAppStore((s) => Math.max(1, s.chatPaneIds?.length ?? 1));
  const setChatPaneCount = useAppStore((s) => s.setChatPaneCount);
  if (!enabled || count > 1) return null;
  return (
    <button
      type="button"
      className={styles.splitFab}
      aria-pressed={false}
      aria-label={t("chat.splitTwo")}
      title={t("chat.splitTwo")}
      onClick={() => setChatPaneCount?.(2)}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3.5" y="5" width="17" height="14" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M12 5.5v13" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    </button>
  );
}

function SplitPaneChrome({
  paneIndex,
  sessionId,
  focused,
  closable,
  showUnsplit,
}: {
  paneIndex: number;
  sessionId: string | null;
  focused: boolean;
  closable: boolean;
  showUnsplit: boolean;
}) {
  const t = useT();
  const title = useAppStore((s) => {
    if (!sessionId) return null;
    return (
      s.sessionDetails?.[sessionId]?.title ??
      s.sessions.find((x) => x.id === sessionId)?.title ??
      null
    );
  });
  const running = useAppStore((s) => {
    if (!sessionId) return false;
    const st =
      s.sessionDetails?.[sessionId]?.status ?? s.sessions.find((x) => x.id === sessionId)?.status;
    return st === "running" || st === "waiting";
  });
  const focusChatPane = useAppStore((s) => s.focusChatPane);
  const closeChatPane = useAppStore((s) => s.closeChatPane);
  const collapseToSinglePane = useAppStore((s) => s.collapseToSinglePane);
  return (
    <div
      className={`${styles.splitChrome}${focused ? ` ${styles.splitChromeFocused}` : ""}`}
      onPointerDown={() => focusChatPane(paneIndex)}
    >
      <span className={styles.splitChromeTitle}>
        {running ? <span className={styles.splitChromeLive} aria-hidden /> : null}
        <span className={styles.splitChromeName}>{title || t("chat.splitEmptyTitle")}</span>
      </span>
      {showUnsplit ? (
        <button
          type="button"
          className={styles.splitChromeUnsplit}
          aria-label={t("chat.splitOne")}
          title={t("chat.splitOne")}
          onClick={(e) => {
            e.stopPropagation();
            collapseToSinglePane();
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="6.5" y="5.5" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        </button>
      ) : null}
      {closable ? (
        <button
          type="button"
          className={styles.splitChromeClose}
          aria-label={t("chat.splitClose")}
          title={t("chat.splitClose")}
          onClick={(e) => {
            e.stopPropagation();
            closeChatPane(paneIndex);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

export function ChatPage() {
  const t = useT();
  const desktop = useDesktopSplit();
  const splitSetting = useAppStore((s) => s.settings.chatSplit !== false);
  const paneIds = useAppStore((s) => s.chatPaneIds) ?? FALLBACK_CHAT_PANES;
  const focusedPaneIndex = useAppStore((s) => s.focusedPaneIndex ?? 0);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const collapseToSinglePane = useAppStore((s) => s.collapseToSinglePane);
  const slots = desktop && splitSetting && paneIds.length > 1 ? paneIds : [activeSessionId];
  const paneCount = slots.length;
  const split = desktop && splitSetting && paneCount > 1;

  useEffect(() => {
    if (!desktop || !splitSetting) collapseToSinglePane();
  }, [desktop, splitSetting, collapseToSinglePane]);

  return (
    <div className={split ? styles.splitWorkspace : styles.splitSingle}>
      <SplitToggleFab enabled={desktop && splitSetting} />
      <div
        className={split ? styles.splitCols : styles.splitColsSingle}
        style={split ? { gridTemplateColumns: `repeat(${paneCount}, minmax(0, 1fr))` } : undefined}
      >
        {slots.map((sessionId, paneIndex) => {
          const focused = paneIndex === focusedPaneIndex || paneCount === 1;
          return (
            <section
              key={`pane-${paneIndex}`}
              className={`${styles.splitPane}${focused ? ` ${styles.splitPaneFocused}` : ""}`}
            >
              {split ? (
                <SplitPaneChrome
                  paneIndex={paneIndex}
                  sessionId={sessionId}
                  focused={focused}
                  closable={paneCount > 1}
                  showUnsplit={paneIndex === paneCount - 1}
                />
              ) : null}
              {sessionId || paneCount === 1 ? (
                <ChatPaneContext.Provider
                  value={{ sessionId, paneIndex, paneCount, focused }}
                >
                  <ChatThread />
                </ChatPaneContext.Provider>
              ) : (
                <div className={styles.splitEmpty}>
                  <p>{t("chat.splitEmpty")}</p>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
