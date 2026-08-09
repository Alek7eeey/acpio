import { MarkdownContent } from "./MarkdownContent";
import { useT } from "../lib/i18n";
import styles from "./Modal.module.css";

export type PlanTodo = {
  id?: string;
  content?: string;
  status?: string;
};

export type PlanPhase = {
  name?: string;
  todos?: PlanTodo[];
};

export type PlanPayload = {
  name?: string;
  overview?: string;
  plan?: string;
  todos?: PlanTodo[];
  phases?: PlanPhase[];
  isProject?: boolean;
};

function todoLabel(todo: PlanTodo) {
  return String(todo.content ?? todo.id ?? "").trim();
}

function TodoList({ todos }: { todos: PlanTodo[] }) {
  if (!todos.length) return null;
  return (
    <ul className={styles.planTodos}>
      {todos.map((todo, i) => {
        const label = todoLabel(todo);
        if (!label) return null;
        const status = String(todo.status ?? "pending").toLowerCase();
        return (
          <li key={todo.id ?? `${label}-${i}`} className={styles.planTodo} data-status={status}>
            <span className={styles.planTodoMark} aria-hidden />
            <span>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function isPlanPayload(
  payload: Record<string, unknown>,
): payload is PlanPayload & Record<string, unknown> {
  const plan = typeof payload.plan === "string" && payload.plan.trim().length > 0;
  const name = typeof payload.name === "string" && payload.name.trim().length > 0;
  const todos = Array.isArray(payload.todos) && payload.todos.length > 0;
  const phases = Array.isArray(payload.phases) && payload.phases.length > 0;
  const entries = Array.isArray(payload.entries) && payload.entries.length > 0;
  return plan || todos || phases || entries || (name && typeof payload.overview === "string");
}

/** Coerce ACP plan updates (entries[]) into the create_plan-shaped payload. */
export function coercePlanPayload(raw: Record<string, unknown>): PlanPayload | null {
  if (!isPlanPayload(raw)) return null;
  const name = String(raw.name ?? raw.title ?? "").trim();
  const overview = String(raw.overview ?? "").trim();
  const plan = String(raw.plan ?? raw.content ?? "").trim();
  let todos: PlanTodo[] = Array.isArray(raw.todos)
    ? (raw.todos as PlanTodo[])
    : [];
  if (!todos.length && Array.isArray(raw.entries)) {
    todos = raw.entries.map((item, i) => {
      const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return {
        id: String(row.id ?? `entry-${i}`),
        content: String(row.content ?? row.title ?? "").trim(),
        status: String(row.status ?? "pending"),
      };
    });
  }
  todos = todos.filter((t) => todoLabel(t));
  const phases = Array.isArray(raw.phases) ? (raw.phases as PlanPhase[]) : undefined;
  if (!plan && !todos.length && !phases?.length && !name) return null;
  return {
    name: name || undefined,
    overview: overview || undefined,
    plan: plan || undefined,
    todos: todos.length ? todos : undefined,
    phases,
    isProject: Boolean(raw.isProject),
  };
}

export function PlanApprovalBody({
  payload,
  fallbackTitle,
  scrollable = true,
}: {
  payload: PlanPayload;
  fallbackTitle: string;
  /** Cap height of plan markdown (modals). Side panel scrolls as a whole. */
  scrollable?: boolean;
}) {
  const t = useT();
  const title = String(payload.name ?? "").trim() || fallbackTitle;
  const overview = String(payload.overview ?? "").trim();
  const plan = String(payload.plan ?? "").trim();
  const todos = Array.isArray(payload.todos) ? payload.todos : [];
  const phases = Array.isArray(payload.phases) ? payload.phases : [];

  return (
    <div className={styles.planBody}>
      <h2 className={styles.planTitle}>{title}</h2>
      {overview ? <p className={styles.planOverview}>{overview}</p> : null}
      {plan ? (
        <div className={`${styles.planMarkdown} ${scrollable ? "" : styles.planMarkdownFree}`}>
          <MarkdownContent text={plan} />
        </div>
      ) : null}
      {todos.length > 0 ? (
        <div className={styles.planSection}>
          <div className={styles.planSectionLabel}>{t("question.todos")}</div>
          <TodoList todos={todos} />
        </div>
      ) : null}
      {phases.map((phase, i) => {
        const phaseTodos = Array.isArray(phase.todos) ? phase.todos : [];
        const phaseName = String(phase.name ?? "").trim() || `Phase ${i + 1}`;
        if (!phaseTodos.length) return null;
        return (
          <div key={`${phaseName}-${i}`} className={styles.planSection}>
            <div className={styles.planSectionLabel}>{phaseName}</div>
            <TodoList todos={phaseTodos} />
          </div>
        );
      })}
    </div>
  );
}
