import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { summarizeQuestionAnswer } from "@acpio/shared";
import { useT } from "../lib/i18n";
import styles from "./ChatInlinePrompt.module.css";

export type InlineQuestion = {
  id: string;
  prompt: string;
  description?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowMultiple?: boolean;
  freeTextField?: string;
  freeTextLabel?: string;
  textInput?: boolean;
  booleanChoice?: boolean;
  defaultValue?: string;
};

export type QuestionPromptPayload = {
  title?: string;
  questions?: InlineQuestion[];
  result?: Record<string, unknown>;
  answerSummary?: string;
  pending?: boolean;
  requestId?: string;
  elicitation?: boolean;
};

type NavItem = {
  questionId: string;
  optionId: string;
};

function navItemKey(item: NavItem) {
  return `${item.questionId}:${item.optionId}`;
}

function listNavItems(questions: InlineQuestion[]): NavItem[] {
  const items: NavItem[] = [];
  for (const q of questions) {
    if (q.booleanChoice) {
      items.push({ questionId: q.id, optionId: "true" });
      items.push({ questionId: q.id, optionId: "false" });
      continue;
    }
    if (q.textInput && !q.options.length) continue;
    for (const opt of q.options) {
      items.push({ questionId: q.id, optionId: opt.id });
    }
  }
  return items;
}

function normalizeLabel(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Drop redundant card title when it repeats the only question prompt. */
export function questionCardTitle(payload: QuestionPromptPayload): string | null {
  const title = String(payload.title ?? "").trim();
  const questions = payload.questions ?? [];
  if (!title) return null;
  if (questions.length === 1) {
    const prompt = String(questions[0]?.prompt ?? "").trim();
    if (prompt && normalizeLabel(title) === normalizeLabel(prompt)) return null;
  }
  return title;
}

function questionShowsPrompt(payload: QuestionPromptPayload, q: InlineQuestion, headline: string | null) {
  const questions = payload.questions ?? [];
  if (questions.length > 1) return true;
  if (!headline) return true;
  return normalizeLabel(q.prompt) !== normalizeLabel(headline);
}

export function ChatQuestionPrompt({
  payload,
  onAnswer,
  embedded = false,
}: {
  payload: QuestionPromptPayload;
  onAnswer: (result: Record<string, unknown>) => void | Promise<void>;
  embedded?: boolean;
}) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);
  const firstTextInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [activeNavIndex, setActiveNavIndex] = useState(0);

  const questions = useMemo(
    () =>
      (payload.questions ?? []).map((q) => ({
        ...q,
        options: q.options ?? [],
      })),
    [payload.questions],
  );

  const navItems = useMemo(() => listNavItems(questions), [questions]);
  const questionResetKey =
    payload.requestId ??
    `${payload.title ?? ""}:${questions.map((q) => q.id).join(",")}`;

  const questionById = useMemo(
    () => new Map(questions.map((q) => [q.id, q] as const)),
    [questions],
  );

  const buildAnswers = () =>
    questions.map((q) => ({
      questionId: q.id,
      selectedOptionIds: selected[q.id] ?? [],
      ...(freeText[q.id]?.trim() ? { freeText: freeText[q.id].trim() } : {}),
    }));

  const submitAnswered = useCallback(() => {
    void onAnswer({
      outcome: {
        outcome: "answered",
        answers: buildAnswers(),
      },
    });
  }, [onAnswer, questions, selected, freeText]);

  const applyNavItem = useCallback(
    (item: NavItem, opts?: { toggle?: boolean }) => {
      const q = questionById.get(item.questionId);
      if (!q) return;
      setSelected((prev) => {
        const cur = prev[item.questionId] ?? [];
        if (q.allowMultiple) {
          if (!opts?.toggle) return prev;
          const active = cur.includes(item.optionId);
          return {
            ...prev,
            [item.questionId]: active
              ? cur.filter((x) => x !== item.optionId)
              : [...cur, item.optionId],
          };
        }
        return { ...prev, [item.questionId]: [item.optionId] };
      });
    },
    [questionById],
  );

  const moveNav = useCallback(
    (delta: number) => {
      if (navItems.length === 0) return;
      setActiveNavIndex((index) => {
        const next = Math.max(0, Math.min(index + delta, navItems.length - 1));
        const item = navItems[next];
        if (item) applyNavItem(item);
        return next;
      });
    },
    [applyNavItem, navItems],
  );

  useEffect(() => {
    setActiveNavIndex(0);
    setSelected({});
    setFreeText({});
    const items = listNavItems(questions);
    if (items.length > 0) {
      const first = items[0]!;
      setSelected({ [first.questionId]: [first.optionId] });
      requestAnimationFrame(() => {
        cardRef.current?.focus({ preventScroll: true });
      });
      return;
    }
    const textQ = questions.find((q) => q.textInput && !q.options.length);
    if (textQ) {
      requestAnimationFrame(() => {
        firstTextInputRef.current?.focus({ preventScroll: true });
      });
    }
  }, [questionResetKey, questions]);

  useEffect(() => {
    const item = navItems[activeNavIndex];
    if (!item) return;
    optionRefs.current
      .get(navItemKey(item))
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeNavIndex, navItems]);

  const handleCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      moveNav(1);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      moveNav(-1);
      return;
    }
    const focused = navItems[activeNavIndex];
    const focusedQ = focused ? questionById.get(focused.questionId) : undefined;
    if (e.key === " " && focused && focusedQ?.allowMultiple) {
      e.preventDefault();
      applyNavItem(focused, { toggle: true });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitAnswered();
    }
  };

  const headline = questionCardTitle(payload);

  const navIndexFor = (questionId: string, optionId: string) =>
    navItems.findIndex((item) => item.questionId === questionId && item.optionId === optionId);

  const selectOption = (q: InlineQuestion, optId: string, allowMultiple: boolean) => {
    const idx = navIndexFor(q.id, optId);
    if (idx >= 0) setActiveNavIndex(idx);
    setSelected((prev) => {
      const cur = prev[q.id] ?? [];
      if (allowMultiple) {
        const active = cur.includes(optId);
        return { ...prev, [q.id]: active ? cur.filter((x) => x !== optId) : [...cur, optId] };
      }
      return { ...prev, [q.id]: [optId] };
    });
  };

  return (
    <div
      ref={cardRef}
      className={`${styles.card} ${embedded ? styles.embedded : ""}`}
      role="group"
      tabIndex={-1}
      data-question-prompt=""
      aria-label={t("question.agentQuestion")}
      onKeyDown={handleCardKeyDown}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("button, input, textarea")) return;
        cardRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className={styles.eyebrow}>{t("question.agentQuestion")}</div>
      {headline ? <div className={styles.title}>{headline}</div> : null}
      <div className={styles.questions}>
        {questions.map((q) => {
          const showPrompt = questionShowsPrompt(payload, q, headline);
          return (
            <div key={q.id} className={styles.q}>
              {showPrompt ? <div className={styles.qPrompt}>{q.prompt}</div> : null}
              {q.description ? <p className={styles.qHint}>{q.description}</p> : null}
              {q.booleanChoice ? (
                <div className={styles.qOptions} role="radiogroup">
                  {[
                    { id: "true", label: t("common.accept") },
                    { id: "false", label: t("common.reject") },
                  ].map((opt) => {
                    const active = (selected[q.id] ?? []).includes(opt.id);
                    const focused = navIndexFor(q.id, opt.id) === activeNavIndex;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        ref={(el) => {
                          const key = navItemKey({ questionId: q.id, optionId: opt.id });
                          if (el) optionRefs.current.set(key, el);
                          else optionRefs.current.delete(key);
                        }}
                        className={`${active ? styles.optActive : styles.opt}${focused ? ` ${styles.optFocused}` : ""}`}
                        role="radio"
                        aria-checked={active}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={() => selectOption(q, opt.id, false)}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              ) : q.textInput && !q.options.length ? (
                <input
                  ref={firstTextInputRef}
                  className={styles.textInput}
                  type="text"
                  value={freeText[q.id] ?? q.defaultValue ?? ""}
                  placeholder={q.freeTextLabel ?? ""}
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(e) => setFreeText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitAnswered();
                    }
                  }}
                />
              ) : (
                <>
                  <div className={styles.qOptions} role={q.allowMultiple ? "group" : "radiogroup"}>
                    {q.options.map((opt) => {
                      const active = (selected[q.id] ?? []).includes(opt.id);
                      const focused = navIndexFor(q.id, opt.id) === activeNavIndex;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          ref={(el) => {
                            const key = navItemKey({ questionId: q.id, optionId: opt.id });
                            if (el) optionRefs.current.set(key, el);
                            else optionRefs.current.delete(key);
                          }}
                          className={`${active ? styles.optActive : styles.opt}${focused ? ` ${styles.optFocused}` : ""}`}
                          role={q.allowMultiple ? "checkbox" : "radio"}
                          aria-checked={active}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onClick={() => selectOption(q, opt.id, Boolean(q.allowMultiple))}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  {q.freeTextField ? (
                    <input
                      className={styles.textInput}
                      type="text"
                      value={freeText[q.id] ?? ""}
                      placeholder={q.freeTextLabel ?? t("question.other")}
                      onMouseDown={(e) => e.stopPropagation()}
                      onChange={(e) => setFreeText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          submitAnswered();
                        }
                      }}
                    />
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.ghost}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void onAnswer({ outcome: { outcome: "skipped" } })}
        >
          {t("common.skip")}
        </button>
        <button
          type="button"
          className={styles.primary}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => submitAnswered()}
        >
          {t("common.send")}
        </button>
      </div>
    </div>
  );
}

export function ChatQuestionAnswered({ payload }: { payload: QuestionPromptPayload }) {
  const t = useT();
  const headline = questionCardTitle(payload) ?? String(payload.title ?? "").trim();
  const summary = summarizeQuestionAnswer(payload);
  const questionLine =
    payload.questions?.length === 1
      ? String(payload.questions[0]?.prompt ?? "").trim()
      : "";
  return (
    <div className={`${styles.card} ${styles.embedded} ${styles.answered}`} aria-label={t("question.agentQuestion")}>
      <div className={styles.eyebrow}>{t("question.agentQuestion")}</div>
      {headline ? <div className={styles.title}>{headline}</div> : null}
      {!headline && questionLine ? <div className={styles.title}>{questionLine}</div> : null}
      <div className={styles.answeredBlock}>
        <div className={styles.answeredLabel}>{t("question.yourAnswer")}</div>
        <p className={styles.overview}>{summary || "—"}</p>
      </div>
    </div>
  );
}
