import { useMemo, useState } from "react";
import { useAppStore } from "../lib/store";
import { useT } from "../lib/i18n";
import styles from "./ChatInlinePrompt.module.css";

type PermissionOption = { optionId: string; name?: string; kind?: string };

type ToolCallPermission = {
  title?: string;
  kind?: string;
  content?: unknown;
  locations?: Array<{ path?: string }>;
  rawInput?: unknown;
};

function optionRank(o: PermissionOption) {
  const kind = o.kind ?? "";
  const id = o.optionId;
  if (kind === "allow_once" || kind === "allow-once" || /allow[_-]?once/i.test(id)) return 0;
  if (kind === "allow_always" || kind === "allow-always" || /allow[_-]?always/i.test(id)) return 1;
  return 2;
}

function optionTone(o: PermissionOption): "primary" | "secondary" | "danger" {
  const kind = o.kind ?? "";
  const id = o.optionId;
  if (kind === "allow_once" || kind === "allow-once" || (/allow/i.test(id) && !/always/i.test(id))) {
    return "primary";
  }
  if (kind === "allow_always" || kind === "allow-always" || /always/i.test(id)) {
    return "secondary";
  }
  return "danger";
}

function textFromUnknown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromUnknown(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    for (const key of ["text", "content", "title", "description", "query", "url", "path", "command"]) {
      const nested = textFromUnknown(row[key]);
      if (nested) return nested;
    }
  }
  return "";
}

/** Prefer fields the agent sent; never invent friendly tool labels. */
function permissionCopy(payload: Record<string, unknown>, toolCall: ToolCallPermission) {
  const title =
    String(payload.title ?? "").trim() ||
    String(toolCall.title ?? "").trim() ||
    "";
  const detail =
    String(payload.description ?? "").trim() ||
    textFromUnknown(toolCall.content) ||
    textFromUnknown(toolCall.rawInput) ||
    toolCall.locations?.map((loc) => String(loc?.path ?? "").trim()).find(Boolean) ||
    "";
  return { title, detail: detail && detail !== title ? detail : "" };
}

export function ChatInlinePrompt({ onOpenPlan }: { onOpenPlan?: () => void }) {
  const t = useT();
  const pendingPermission = useAppStore((s) => s.pendingPermission);
  const permissionQueue = useAppStore((s) => s.permissionQueue);
  const pendingQuestion = useAppStore((s) => s.pendingQuestion);
  const answerPermission = useAppStore((s) => s.answerPermission);
  const answerQuestion = useAppStore((s) => s.answerQuestion);
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const questions = useMemo(() => {
    if (!pendingQuestion || pendingQuestion.kind !== "ask_question") return [];
    return (
      (pendingQuestion.payload.questions as Array<{
        id: string;
        prompt: string;
        options: Array<{ id: string; label: string }>;
        allowMultiple?: boolean;
      }>) ?? []
    );
  }, [pendingQuestion]);

  if (pendingPermission) {
    const payload = pendingPermission.payload as Record<string, unknown>;
    const toolCall = (payload.toolCall ?? {}) as ToolCallPermission;
    const { title, detail } = permissionCopy(payload, toolCall);
    const options =
      (payload.options as PermissionOption[] | undefined)?.filter((o) => o?.optionId) ?? [];
    const buttons: PermissionOption[] =
      options.length > 0
        ? [...options].sort((a, b) => optionRank(a) - optionRank(b))
        : [
            { optionId: "allow-once", kind: "allow_once", name: t("permission.allowOnce") },
            { optionId: "allow-always", kind: "allow_always", name: t("permission.allowAlways") },
            { optionId: "reject-once", kind: "reject_once", name: t("permission.reject") },
          ];

    const labelFor = (opt: PermissionOption) => {
      const tone = optionTone(opt);
      if (tone === "primary") return t("permission.allowOnce");
      if (tone === "secondary") return t("permission.allowAlways");
      return t("permission.reject");
    };

    const queued = permissionQueue.length;

    return (
      <div className={styles.card} role="group" aria-label={t("permission.title")}>
        <div className={styles.eyebrow}>
          {t("permission.title")}
          {queued > 0 ? ` · +${queued}` : ""}
        </div>
        <div className={styles.title}>{title || t("permission.description")}</div>
        {detail ? <p className={styles.overview}>{detail}</p> : null}
        <div className={styles.actions}>
          {buttons.map((opt) => {
            const tone = optionTone(opt);
            return (
              <button
                key={opt.optionId}
                type="button"
                className={
                  tone === "primary"
                    ? styles.primary
                    : tone === "danger"
                      ? styles.danger
                      : styles.ghost
                }
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void answerPermission(opt.optionId);
                }}
              >
                {labelFor(opt)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (pendingQuestion?.kind === "create_plan") {
    const name = String(pendingQuestion.payload.name ?? "").trim() || t("question.plan");
    const overview = String(pendingQuestion.payload.overview ?? "").trim();
    return (
      <div className={styles.card} role="group" aria-label={t("question.plan")}>
        <div className={styles.eyebrow}>{t("question.planReady")}</div>
        <div className={styles.title}>{name}</div>
        {overview ? <p className={styles.overview}>{overview}</p> : null}
        <div className={styles.actions}>
          {onOpenPlan ? (
            <button type="button" className={styles.ghost} onClick={onOpenPlan}>
              {t("question.openPlan")}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.danger}
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
    );
  }

  if (pendingQuestion?.kind === "ask_question") {
    return (
      <div className={styles.card} role="group" aria-label={t("question.agentQuestion")}>
        <div className={styles.eyebrow}>{t("question.agentQuestion")}</div>
        <div className={styles.title}>
          {String(pendingQuestion.payload.title ?? t("question.agentQuestion"))}
        </div>
        <div className={styles.questions}>
          {questions.map((q) => (
            <div key={q.id} className={styles.q}>
              <div className={styles.qPrompt}>{q.prompt}</div>
              <div className={styles.qOptions}>
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
            className={styles.ghost}
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
    );
  }

  return null;
}
