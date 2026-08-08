import { Link } from "react-router-dom";
import { modelDisplayName } from "@acprocess/shared";
import { HoverTip } from "../components/HoverTip";
import { useAppStore } from "../lib/store";
import styles from "./DashboardPage.module.css";

const modules = [
  {
    id: "chat",
    to: "/chat",
    title: "AI-чат",
    subtitle: "ACP · Cursor / OpenCode",
    description: "Чат с агентом: рассуждения и ответы в одной ленте.",
    status: "ready" as const,
    cta: "Открыть чат",
  },
  {
    id: "gitea",
    to: "/gitea",
    title: "Gitea",
    subtitle: "Git · PR · конфликты",
    description: "Коммиты, pull request и резолв конфликтов через агента и Gitea API.",
    status: "soon" as const,
    cta: "Скоро",
  },
  {
    id: "processes",
    to: "#",
    title: "Процессы",
    subtitle: "Оркестрация",
    description: "Оркестрация внутренних процессов через агентов ACP.",
    status: "soon" as const,
    cta: "Скоро",
  },
];

export function DashboardPage() {
  const settings = useAppStore((s) => s.settings);
  const sessions = useAppStore((s) => s.sessions);
  const connected = useAppStore((s) => s.connected);

  const provider = settings.defaultProvider;
  const model = settings.defaultModel
    ? modelDisplayName(settings.defaultModel)
    : "не выбрана";

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Harness</p>
          <h1>
            <span>ACP</span>rocess
          </h1>
          <p className={styles.lead}>
            Единая панель для агентов и внутренних модулей. Настройки — в меню аккаунта.
          </p>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Агент</span>
            <strong>{provider}</strong>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Модель</span>
            <strong className={styles.truncate}>{model}</strong>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Сессии</span>
            <strong>{sessions.length}</strong>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>WS</span>
            <strong className={connected ? styles.ok : styles.bad}>
              {connected ? "online" : "offline"}
            </strong>
          </div>
        </div>
      </section>

      <section className={styles.grid}>
        {modules.map((mod) => {
          const inner = (
            <>
              <div className={styles.cardTop}>
                <div>
                  <h2>{mod.title}</h2>
                  <p className={styles.subtitle}>{mod.subtitle}</p>
                </div>
                <span className={mod.status === "ready" ? styles.badgeReady : styles.badgeSoon}>
                  {mod.status === "ready" ? "Готово" : "Скоро"}
                </span>
              </div>
              <p className={styles.desc}>{mod.description}</p>
              <span className={styles.cta}>{mod.cta}</span>
            </>
          );

          if (mod.status === "soon") {
            return (
              <HoverTip key={mod.id} className={`${styles.card} ${styles.cardSoon}`} aria-disabled="true">
                {inner}
              </HoverTip>
            );
          }

          return (
            <Link key={mod.id} to={mod.to} className={styles.card}>
              {inner}
            </Link>
          );
        })}
      </section>
    </div>
  );
}
