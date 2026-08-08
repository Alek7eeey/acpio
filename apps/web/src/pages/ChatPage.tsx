import { Link } from "react-router-dom";
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import { migrateModelParamValues, type MessageDto, type MessagePartDto, type ModelParamDto } from "@acprocess/shared";
import { api } from "../lib/api";
import { useAppStore } from "../lib/store";
import { ModelPicker } from "../components/ModelPicker";
import { HoverTip } from "../components/HoverTip";
import { PermissionModal } from "../components/PermissionModal";
import { QuestionModal } from "../components/QuestionModal";
import {
  collectRecentCwds,
  CreateSessionFolderPicker,
} from "../components/CreateSessionFolderPicker";
import styles from "./ChatPage.module.css";

function peelAnswerFromThought(thought: string): { thought: string; answer: string } {
  const trimmed = thought.trim();
  if (!trimmed) return { thought: "", answer: "" };
  const blocks = trimmed.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length < 2) return { thought: trimmed, answer: "" };
  const first = blocks[0];
  const rest = blocks.slice(1).join("\n\n");
  const meta =
    /^(the user|let me|i (need|should|will|think)|okay|ok[,.]|hmm|рассужд|пользователь)/i.test(
      first,
    ) ||
    (first.length < 280 && rest.length > first.length * 1.2);
  if (!meta || rest.length < 24) return { thought: trimmed, answer: "" };
  return { thought: first, answer: rest };
}

function coalesceParts(parts: MessagePartDto[]): MessagePartDto[] {
  const out: MessagePartDto[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (
      prev &&
      part.type === prev.type &&
      (part.type === "thought" || part.type === "text")
    ) {
      const prevText = String(prev.payload.text ?? "");
      const nextText = String(part.payload.text ?? "");
      out[out.length - 1] = {
        ...prev,
        payload: { ...prev.payload, text: prevText + nextText },
      };
      continue;
    }
    // Merge any later thought into the first thought block of the message
    if (part.type === "thought") {
      const thoughtIdx = out.findIndex((p) => p.type === "thought");
      if (thoughtIdx >= 0) {
        const existing = out[thoughtIdx];
        out[thoughtIdx] = {
          ...existing,
          payload: {
            ...existing.payload,
            text: String(existing.payload.text ?? "") + String(part.payload.text ?? ""),
          },
        };
        continue;
      }
    }
    out.push(part);
  }

  const hasText = out.some((p) => p.type === "text" && String(p.payload.text ?? "").trim());
  if (!hasText) {
    const thoughtIdx = out.findIndex((p) => p.type === "thought");
    if (thoughtIdx >= 0) {
      const thought = out[thoughtIdx];
      const peeled = peelAnswerFromThought(String(thought.payload.text ?? ""));
      if (peeled.answer) {
        out[thoughtIdx] = {
          ...thought,
          payload: { ...thought.payload, text: peeled.thought },
        };
        out.splice(thoughtIdx + 1, 0, {
          ...thought,
          id: `${thought.id}-peeled-answer`,
          type: "text",
          order: thought.order + 0.5,
          payload: { text: peeled.answer },
        });
      }
    }
  }

  // Keep single thought near the top of assistant content
  const thought = out.find((p) => p.type === "thought");
  const rest = out.filter((p) => p.type !== "thought");
  return thought ? [thought, ...rest] : out;
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
  const [open, setOpen] = useState(false);

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
      <div className={`${styles.textPart} ${streaming ? styles.streaming : ""}`}>
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    );
  }

  if (part.type === "thought") {
    const text = String(part.payload.text ?? "");
    if (!text.trim()) return null;
    const steps = text
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    const body = (
      <div className={styles.thoughtChain}>
        {steps.map((step, i) => (
          <div key={i} className={styles.thoughtStep}>
            {steps.length > 1 && <span className={styles.thoughtStepIndex}>{i + 1}</span>}
            <pre className={`${styles.pre} ${styles.thoughtBody}`}>{step}</pre>
          </div>
        ))}
      </div>
    );
    if (embedded) {
      return (
        <div className={`${styles.thoughtEmbedded} ${streaming ? styles.thoughtLive : ""}`}>
          <div className={styles.thoughtEmbeddedLabel}>
            {streaming && <span className={styles.pulseDot} />}
            Рассуждение
          </div>
          {body}
        </div>
      );
    }
    return (
      <div
        className={`${styles.thought} ${open ? styles.thoughtOpen : ""} ${
          streaming ? styles.thoughtLive : ""
        }`}
      >
        <button {...toggleProps} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={styles.thoughtLabel}>
            {streaming && <span className={styles.pulseDot} />}
            Рассуждение
            {!streaming && steps.length > 1 ? (
              <span className={styles.thoughtMeta}>{steps.length} шагов</span>
            ) : null}
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
    const title = String(
      part.payload.description ?? part.payload.subagentType ?? part.payload.title ?? "Субагент",
    );
    const status = String(part.payload.status ?? "");
    return (
      <div className={styles.subagent}>
        <button {...toggleProps} onClick={() => setOpen(!open)}>
          <span>
            Субагент · {title}
            {status ? ` · ${status}` : ""}
          </span>
          <span>{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className={styles.subagentBody}>
            {typeof part.payload.prompt === "string" && (
              <p className={styles.subagentPrompt}>{String(part.payload.prompt)}</p>
            )}
            {typeof part.payload.result === "string" && (
              <pre className={styles.pre}>{String(part.payload.result)}</pre>
            )}
            {!part.payload.prompt && !part.payload.result && (
              <pre className={styles.pre}>
                {JSON.stringify(
                  {
                    description: part.payload.description,
                    subagentType: part.payload.subagentType,
                    status: part.payload.status,
                  },
                  null,
                  2,
                )}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  if (part.type === "tool_call") {
    const title = String(part.payload.title ?? "Tool");
    const status = String(part.payload.status ?? "");
    const kind = String(
      (part.payload.raw as { kind?: string } | undefined)?.kind ?? part.payload.kind ?? "",
    );
    const isTask = /task|subagent|explore|agent/i.test(`${title} ${kind}`);
    const label = isTask ? "Субагент" : "Инструмент";
    return (
      <div className={isTask ? styles.subagent : styles.toolChip}>
        <div className={styles.toolChipInner}>
          <span className={styles.toolChipLabel}>
            {streaming && status !== "completed" && status !== "failed" && (
              <span className={styles.pulseDot} />
            )}
            {label} · {title}
            {status ? ` · ${status}` : ""}
          </span>
        </div>
      </div>
    );
  }

  if (part.type === "error") {
    return <div className={styles.error}>{String(part.payload.message ?? "Ошибка")}</div>;
  }

  return null;
}

function isStepPart(part: MessagePartDto) {
  return part.type === "thought" || part.type === "tool_call" || part.type === "subagent";
}

function StepsSpoiler({
  parts,
  streaming,
}: {
  parts: MessagePartDto[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const visible = parts.filter((part) => {
    if (part.type === "thought") return Boolean(String(part.payload.text ?? "").trim());
    return true;
  });
  const count = visible.length;

  if (count === 0) return null;

  return (
    <div
      className={`${styles.steps} ${open ? styles.stepsOpen : ""} ${
        streaming ? styles.stepsLive : ""
      }`}
    >
      <button
        type="button"
        tabIndex={-1}
        className={styles.partToggle}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.thoughtLabel}>
          {streaming && <span className={styles.pulseDot} />}
          Шаги
          <span className={styles.thoughtMeta}>
            {count} {count === 1 ? "шаг" : count < 5 ? "шага" : "шагов"}
          </span>
        </span>
        <span className={styles.thoughtChevron} aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className={styles.stepsBody}>
          {visible.map((part, idx) => (
            <PartView
              key={part.type === "thought" ? "thought" : part.id}
              part={part}
              embedded
              streaming={
                streaming &&
                idx === visible.length - 1 &&
                (part.type === "thought" || part.type === "tool_call")
              }
            />
          ))}
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
    if (p.type === "error") {
      return Boolean(String(p.payload.message ?? "").trim());
    }
    if (p.type === "tool_call" || p.type === "subagent") {
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

function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <div className={styles.msgActions} aria-label="Действия">
      <button
        type="button"
        className={styles.msgAction}
        title={copied ? "Скопировано" : "Копировать"}
        aria-label="Копировать"
        onClick={() => void copy()}
      >
        {copied ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
            <path
              d="M6 16V6a2 2 0 0 1 2-2h10"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>
      <HoverTip as="button" className={styles.msgAction} aria-label="Нравится" text="Скоро">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M7 11v9H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h2Zm0 0 4.2-7.2A2.2 2.2 0 0 1 13.2 3h.3a2 2 0 0 1 2 2.3L14.8 11H20a2 2 0 0 1 2 2.3l-1.1 5.2A3 3 0 0 1 18 21H7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label="Не нравится" text="Скоро">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M17 13V4h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2Zm0 0-4.2 7.2A2.2 2.2 0 0 1 10.8 21h-.3a2 2 0 0 1-2-2.3L9.2 13H4a2 2 0 0 1-2-2.3L3.1 5.5A3 3 0 0 1 6 3h11"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label="Поделиться" text="Скоро">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3v10M12 3l-3.5 3.5M12 3l3.5 3.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label="Повторить" text="Скоро">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label="Ещё" text="Скоро">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="19" cy="12" r="1.5" fill="currentColor" />
        </svg>
      </HoverTip>
    </div>
  );
}

function AssistantParts({
  message,
  streaming,
}: {
  message: MessageDto;
  streaming: boolean;
}) {
  const parts = useMemo(() => {
    const coalesced = coalesceParts(message.parts);
    return coalesced.filter(
      (p) =>
        p.type === "thought" ||
        p.type === "text" ||
        p.type === "error" ||
        p.type === "subagent" ||
        p.type === "tool_call",
    );
  }, [message.id, message.parts]);

  const stepParts = useMemo(() => parts.filter(isStepPart), [parts]);
  const mainParts = useMemo(() => parts.filter((p) => !isStepPart(p)), [parts]);
  const plain = useMemo(() => assistantPlainText(message), [message]);

  return (
    <div className={styles.parts}>
      <StepsSpoiler parts={stepParts} streaming={streaming} />
      {mainParts.map((part, idx) => {
        const isLast = idx === mainParts.length - 1;
        return (
          <PartView
            key={part.id}
            part={part}
            streaming={streaming && isLast && part.type === "text"}
          />
        );
      })}
      {!streaming && plain ? <MessageActions text={plain} /> : null}
    </div>
  );
}

export function ChatPage() {
  const activeSession = useAppStore((s) => s.activeSession);
  const sessions = useAppStore((s) => s.sessions);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const cancelPrompt = useAppStore((s) => s.cancelPrompt);
  const createSession = useAppStore((s) => s.createSession);
  const error = useAppStore((s) => s.error);
  const modelsCatalog = useAppStore((s) => s.modelsCatalog);
  const modelsLoading = useAppStore((s) => s.modelsLoading);
  const ensureModels = useAppStore((s) => s.ensureModels);
  const rememberModelsCatalog = useAppStore((s) => s.rememberModelsCatalog);
  const [text, setText] = useState("");
  const [modelParamValues, setModelParamValues] = useState<Record<string, string>>(
    () => settings.defaultModelParams ?? {},
  );
  const [model, setModel] = useState(settings.defaultModel);
  const [folderPicker, setFolderPicker] = useState<{ x: number; y: number } | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [stableParams, setStableParams] = useState<ModelParamDto[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const keepComposerFocus = useRef(false);
  const paramsCacheRef = useRef(new Map<string, ModelParamDto[]>());
  const streaming = activeSession?.status === "running" || activeSession?.status === "waiting";

  // Models follow the connected agent in Settings (not a stale session.provider).
  const agentProvider = settings.defaultProvider;

  const catalog = modelsCatalog?.provider === agentProvider ? modelsCatalog : null;
  const models = catalog?.models ?? [];
  const modelParams = catalog?.modelParams ?? [];
  // Block typing only while we have nothing cached and a fetch is in flight.
  const composerLocked = modelsLoading && models.length === 0;

  const recentCwds = useMemo(
    () => collectRecentCwds(sessions, settings.defaultCwd),
    [sessions, settings.defaultCwd],
  );
  useEffect(() => {
    const cached = useAppStore.getState().modelsCatalog;
    const needForce = !cached || cached.provider !== agentProvider;
    void ensureModels(agentProvider, { force: needForce });
  }, [agentProvider, ensureModels]);

  useEffect(() => {
    if (paramsLoading) return;
    setStableParams(modelParams);
    if (model && modelParams.length) {
      paramsCacheRef.current.set(model, modelParams);
    }
  }, [modelParams, model, paramsLoading]);

  useEffect(() => {
    if (!catalog?.models.length) {
      setModel(settings.defaultModel);
      setModelParamValues(settings.defaultModelParams ?? {});
      return;
    }
    // Drop a defaultModel that belongs to another agent (e.g. Cursor id in OpenCode chat).
    const preferred = settings.defaultModel || catalog.currentModel || "";
    const nextModel =
      preferred && catalog.models.some((m) => m.value === preferred)
        ? preferred
        : catalog.currentModel || catalog.models[0]?.value || "";
    setModel(nextModel);
    const exposed = catalog.modelParams ?? [];
    if (!exposed.length) {
      setModelParamValues(settings.defaultModelParams ?? {});
      return;
    }
    const migrated = migrateModelParamValues(settings.defaultModelParams ?? {}, exposed);
    setModelParamValues(
      Object.keys(migrated).length
        ? migrated
        : Object.fromEntries(
            exposed
              .filter((p) => p.currentValue != null && p.currentValue !== "")
              .map((p) => [p.id, p.currentValue!]),
          ),
    );
  }, [catalog, settings.defaultModel, settings.defaultModelParams]);

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
    await saveSettings({ defaultModel: nextModel, defaultModelParams: supported });
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
    setParamsLoading(true);
    try {
      const fresh = await applyModelSelection(nextModel, {});
      const committed = fresh?.length ? fresh : [];
      paramsCacheRef.current.set(nextModel, committed);
      setStableParams(committed);
    } finally {
      setParamsLoading(false);
    }
  };

  const onModelChange = async (value: string) => {
    // Don't carry Fast/Effort from the previous model — they often aren't valid
    // for the new one and used to leave the ACP session broken.
    await applyModelSelection(value, {});
  };

  const onParamsChange = async (next: Record<string, string>) => {
    const fresh = await applyModelSelection(model, next);
    if (fresh?.length) {
      paramsCacheRef.current.set(model, fresh);
      setStableParams(fresh);
    }
  };

  const focusComposer = () => {
    const el = textareaRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    el.focus({ preventScroll: true });
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    keepComposerFocus.current = streaming || keepComposerFocus.current;
    if (!streaming) {
      // release a bit after turn ends
      const t = window.setTimeout(() => {
        keepComposerFocus.current = false;
      }, 300);
      return () => window.clearTimeout(t);
    }
    focusComposer();
  }, [streaming]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (keepComposerFocus.current) focusComposer();
  }, [activeSession?.messages, activeSession?.status]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const onFocusIn = (e: FocusEvent) => {
      if (!keepComposerFocus.current) return;
      const target = e.target as Node | null;
      if (!target || target === textareaRef.current) return;
      if (thread.contains(target)) {
        focusComposer();
      }
    };
    thread.addEventListener("focusin", onFocusIn);
    return () => thread.removeEventListener("focusin", onFocusIn);
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (composerLocked || streaming) return;
    const value = text.trim();
    if (!value) return;
    keepComposerFocus.current = true;
    setText("");
    focusComposer();
    void sendPrompt(value).finally(() => {
      requestAnimationFrame(focusComposer);
      window.setTimeout(focusComposer, 0);
      window.setTimeout(focusComposer, 100);
    });
  };

  const lastAssistantId = [...(activeSession?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  return (
    <div className={styles.page}>
      <div className={styles.thread} ref={threadRef}>
        {!activeSession && (
          <div className={styles.empty}>
            <h1>
              <span>ACP</span>rocess
            </h1>
            <p>
              Харнесс для Cursor, OpenCode, OMP и PI. Рассуждение идёт одним блоком, ответ стримится в ленте.
            </p>
            <div className={styles.emptyActions}>
              <button
                type="button"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                  setFolderPicker({ x: rect.left, y: rect.bottom + 8 });
                }}
              >
                Начать чат
              </button>
              <Link
                className={styles.secondary}
                to="/settings"
                style={{ display: "inline-flex", alignItems: "center" }}
              >
                Настроить агента
              </Link>
            </div>
          </div>
        )}

        {activeSession?.messages.map((msg) => {
          const isLiveAssistant = streaming && msg.id === lastAssistantId;
          // Don't render an empty assistant shell — it caused a blank gap
          // between "Агент думает" and the first streamed tokens.
          if (
            msg.role === "assistant" &&
            !hasRenderableAssistantContent(msg.parts)
          ) {
            return null;
          }
          return (
            <article
              key={msg.id}
              className={`${styles.msg} ${styles[msg.role]} ${isLiveAssistant ? styles.live : ""}`}
              onMouseDown={(e) => {
                if (!keepComposerFocus.current) return;
                const target = e.target as HTMLElement;
                if (target.closest("button,a,input,textarea")) return;
                e.preventDefault();
              }}
            >
              {msg.role === "user" ? (
                <div className={styles.userBubble} contentEditable={false} suppressContentEditableWarning>
                  {msg.parts.map((part) =>
                    part.type === "text" ? (
                      <div key={part.id}>{String(part.payload.text ?? "")}</div>
                    ) : (
                      <PartView key={part.id} part={part} />
                    ),
                  )}
                </div>
              ) : (
                <AssistantParts message={msg} streaming={!!isLiveAssistant} />
              )}
            </article>
          );
        })}
      </div>

      {error && <div className={styles.banner}>{error}</div>}

      <form className={styles.composer} onSubmit={onSubmit}>
        <div className={styles.composerInner}>
          {composerLocked && (
            <div className={styles.typingBar} aria-live="polite">
              <span className={styles.modelsLoaderSpin} aria-hidden />
              <span>Загрузка моделей…</span>
            </div>
          )}
          {activeSession?.status === "running" && (
            <div className={styles.typingBar} aria-live="polite">
              <span>Агент думает</span>
              <span className={styles.typingDots} aria-hidden>
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
          {activeSession?.status === "waiting" && (
            <div className={styles.typingBar}>Ждёт вашего ответа…</div>
          )}
          {activeSession?.cwd?.trim() ? (
            <div className={styles.sessionCwd} title={activeSession.cwd}>
              <span className={styles.sessionCwdIcon} aria-hidden>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
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
              </span>
              <span className={styles.sessionCwdText}>
                {activeSession.cwd.length > 56
                  ? `…${activeSession.cwd.slice(-54)}`
                  : activeSession.cwd}
              </span>
            </div>
          ) : null}
          <div
            className={`${styles.pill} ${streaming ? styles.pillBusy : ""} ${
              composerLocked ? styles.pillLoading : ""
            }`}
          >
            <HoverTip
              as="button"
              className={styles.attachBtn}
              aria-label="Прикрепление файлов пока не реализовано"
              disabled={composerLocked}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </HoverTip>

            <textarea
              ref={textareaRef}
              className={styles.pillInput}
              value={text}
              onChange={(e) => {
                if (composerLocked) return;
                setText(e.target.value);
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
              }}
              placeholder={composerLocked ? "Загрузка моделей…" : "Введите сообщение…"}
              rows={1}
              disabled={composerLocked}
              readOnly={composerLocked}
              aria-busy={composerLocked || undefined}
              onKeyDown={(e) => {
                if (composerLocked) {
                  e.preventDefault();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
            />

            <ModelPicker
              className={styles.composerModel}
              model={model}
              models={models}
              params={stableParams}
              paramValues={modelParamValues}
              paramsLoading={paramsLoading}
              loading={composerLocked}
              disabled={composerLocked}
              onOpen={() => {
                const cached = useAppStore.getState().modelsCatalog;
                const stale =
                  !cached ||
                  cached.provider !== agentProvider ||
                  (cached.modelParams?.length ?? 0) === 0;
                void ensureModels(agentProvider, { force: stale });
              }}
              onChange={(v) => void onModelChange(v)}
              onParamsOpen={(v) => loadParamsForModel(v)}
              onParamsChange={(next) => void onParamsChange(next)}
            />

            {streaming ? (
              <button
                type="button"
                className={styles.stopBtn}
                title="Остановить"
                aria-label="Остановить"
                onClick={() => void cancelPrompt()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                className={styles.sendBtn}
                disabled={composerLocked || !text.trim()}
                title={composerLocked ? "Загрузка моделей…" : "Отправить"}
                aria-label="Отправить"
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
          </div>
        </div>
      </form>

      <PermissionModal />
      <QuestionModal />
      {folderPicker && (
        <CreateSessionFolderPicker
          x={folderPicker.x}
          y={folderPicker.y}
          defaultCwd={settings.defaultCwd ?? ""}
          dialogStartPath={settings.defaultCwd?.trim() || ""}
          recentCwds={recentCwds}
          onClose={() => setFolderPicker(null)}
          onConfirm={async (cwd) => {
            setFolderPicker(null);
            await createSession(undefined, cwd);
            focusComposer();
          }}
        />
      )}
    </div>
  );
}
