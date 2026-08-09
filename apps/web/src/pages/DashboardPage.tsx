import { Link } from "react-router-dom";
import { modelDisplayName } from "@acprocess/shared";
import { HoverTip } from "../components/HoverTip";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import styles from "./DashboardPage.module.css";

export function DashboardPage() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const sessions = useAppStore((s) => s.sessions);
  const connected = useAppStore((s) => s.connected);

  const modules = [
    {
      id: "chat",
      to: "/chat",
      title: t("dashboard.chatTitle"),
      subtitle: t("dashboard.chatSubtitle"),
      description: t("dashboard.chatDescription"),
      status: "ready" as const,
      cta: t("common.openChat"),
    },
    {
      id: "gitea",
      to: "/gitea",
      title: t("dashboard.giteaTitle"),
      subtitle: t("dashboard.giteaSubtitle"),
      description: t("dashboard.giteaDescription"),
      status: "soon" as const,
      cta: t("common.soon"),
    },
    {
      id: "processes",
      to: "#",
      title: t("dashboard.processesTitle"),
      subtitle: t("dashboard.processesSubtitle"),
      description: t("dashboard.processesDescription"),
      status: "soon" as const,
      cta: t("common.soon"),
    },
  ];

  const provider = settings.connectedProvider;
  const providerLabel = !provider
    ? t("common.notConnected")
    : provider === "cursor"
      ? "Cursor"
      : provider === "opencode"
        ? "OpenCode"
        : provider === "omp"
          ? "OMP"
          : provider === "pi"
            ? "PI"
            : provider;
  const model =
    provider && settings.defaultModel
      ? modelDisplayName(settings.defaultModel, undefined, t("models.default"))
      : "—";

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Harness</p>
          <h1>
            <span>ACP</span>rocess
          </h1>
          <p className={styles.lead}>{t("dashboard.tagline")}</p>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t("common.agent")}</span>
            <strong className={!provider ? styles.bad : undefined}>{providerLabel}</strong>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t("common.model")}</span>
            <strong className={styles.truncate}>{model}</strong>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t("chat.newSession")}</span>
            <strong>{sessions.length}</strong>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>WS</span>
            <strong className={connected ? styles.ok : styles.bad}>
              {connected ? t("common.online") : t("common.offline")}
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
                  {mod.status === "ready" ? t("common.ready") : t("common.soon")}
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
