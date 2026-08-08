import { useMemo, useState } from "react";
import { useAppStore } from "../lib/store";
import { useT } from "../lib/i18n";
import styles from "./Modal.module.css";

export function QuestionModal() {
  const t = useT();
  const pending = useAppStore((s) => s.pendingQuestion);
  const answerQuestion = useAppStore((s) => s.answerQuestion);
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const questions = useMemo(() => {
    if (!pending || pending.kind !== "ask_question") return [];
    return (pending.payload.questions as Array<{
      id: string;
      prompt: string;
      options: Array<{ id: string; label: string }>;
      allowMultiple?: boolean;
    }>) ?? [];
  }, [pending]);

  if (!pending) return null;

  if (pending.kind === "create_plan") {
    return (
      <div className={styles.overlay}>
        <div className={styles.modal} role="dialog" aria-modal="true">
          <h2>{String(pending.payload.name ?? t("question.plan"))}</h2>
          <p className={styles.muted}>{String(pending.payload.overview ?? "")}</p>
          <pre className={styles.pre}>{String(pending.payload.plan ?? "")}</pre>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() =>
                void answerQuestion({ outcome: { outcome: "rejected", reason: "rejected by user" } })
              }
            >
              {t("common.reject")}
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void answerQuestion({ outcome: { outcome: "accepted" } })}
            >
              {t("common.accept")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <h2>{String(pending.payload.title ?? t("question.agentQuestion"))}</h2>
        <div className={styles.questions}>
          {questions.map((q) => (
            <div key={q.id} className={styles.q}>
              <div className={styles.qPrompt}>{q.prompt}</div>
              <div className={styles.options}>
                {q.options.map((opt) => {
                  const active = (selected[q.id] ?? []).includes(opt.id);
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={active ? styles.optActive : styles.opt}
                      onClick={() => {
                        setSelected((prev) => {
                          const cur = prev[q.id] ?? [];
                          if (q.allowMultiple) {
                            return {
                              ...prev,
                              [q.id]: active ? cur.filter((x) => x !== opt.id) : [...cur, opt.id],
                            };
                          }
                          return { ...prev, [q.id]: [opt.id] };
                        });
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => void answerQuestion({ outcome: { outcome: "skipped" } })}
          >
            {t("common.skip")}
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() =>
              void answerQuestion({
                outcome: {
                  outcome: "answered",
                  answers: questions.map((q) => ({
                    questionId: q.id,
                    selectedOptionIds: selected[q.id] ?? [],
                  })),
                },
              })
            }
          >
            {t("common.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
