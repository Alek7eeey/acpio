import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import type { AdminUserDto, AgentProvider } from "@acprocess/shared";
import { api } from "../lib/api";
import { useLocale, useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import styles from "./AdminPage.module.css";

function providerLabel(provider: AgentProvider | null) {
  if (!provider) return null;
  if (provider === "cursor") return "Cursor";
  if (provider === "opencode") return "OpenCode";
  if (provider === "omp") return "OMP";
  if (provider === "pi") return "PI";
  return provider;
}

export function AdminPage() {
  const t = useT();
  const locale = useLocale();
  const me = useAppStore((s) => s.user);
  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const formatDate = useCallback(
    (iso: string) => {
      try {
        return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "ru-RU", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(iso));
      } catch {
        return iso;
      }
    },
    [locale],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.adminListUsers();
      setUsers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!me || me.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  const onDelete = async (user: AdminUserDto) => {
    if (user.id === me.id) return;
    const ok = window.confirm(t("common.deleteUserConfirm", { username: user.username }));
    if (!ok) return;
    setDeletingId(user.id);
    setError(null);
    try {
      await api.adminDeleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{t("common.admin")}</p>
        <h1>{t("common.usersTitle")}</h1>
        <p className={styles.lead}>{t("settings.agentConnectDesc")}</p>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <strong>
            {loading
              ? t("common.loading")
              : t("common.userCount", { count: users.length })}
          </strong>
          <button type="button" className={styles.ghostBtn} disabled={loading} onClick={() => void load()}>
            {t("common.refresh")}
          </button>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("common.user")}</th>
                <th>{t("common.role")}</th>
                <th>{t("common.agent")}</th>
                <th>{t("common.created")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!loading && users.length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.empty}>
                    {t("common.emptyList")}
                  </td>
                </tr>
              )}
              {users.map((user) => {
                const agent = providerLabel(user.connectedProvider);
                const isSelf = user.id === me.id;
                return (
                  <tr key={user.id}>
                    <td>
                      <div className={styles.userCell}>
                        <strong>{user.displayName}</strong>
                        <span>@{user.username}</span>
                      </div>
                    </td>
                    <td>
                      <span className={user.role === "admin" ? styles.roleAdmin : styles.roleUser}>
                        {user.role === "admin" ? "admin" : "user"}
                      </span>
                    </td>
                    <td>
                      {agent ? (
                        <span className={styles.agentOn}>{agent}</span>
                      ) : (
                        <span className={styles.agentOff}>{t("common.notConnected")}</span>
                      )}
                    </td>
                    <td className={styles.muted}>{formatDate(user.createdAt)}</td>
                    <td className={styles.actions}>
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        disabled={isSelf || deletingId === user.id}
                        title={isSelf ? t("common.cannotDeleteSelf") : t("common.delete")}
                        onClick={() => void onDelete(user)}
                      >
                        {deletingId === user.id ? "…" : t("common.delete")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
