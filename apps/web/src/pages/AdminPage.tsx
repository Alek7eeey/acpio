import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import type { AdminUserDto, AgentProvider } from "@acprocess/shared";
import { api } from "../lib/api";
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

function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function AdminPage() {
  const me = useAppStore((s) => s.user);
  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
    const ok = window.confirm(`Удалить пользователя @${user.username}?`);
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
        <p className={styles.eyebrow}>Admin</p>
        <h1>Пользователи</h1>
        <p className={styles.lead}>
          Список аккаунтов и агент, который пользователь подключил в настройках.
        </p>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <strong>
            {loading ? "Загрузка…" : `${users.length} ${users.length === 1 ? "пользователь" : "пользователей"}`}
          </strong>
          <button type="button" className={styles.ghostBtn} disabled={loading} onClick={() => void load()}>
            Обновить
          </button>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Роль</th>
                <th>Агент</th>
                <th>Создан</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!loading && users.length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.empty}>
                    Пользователей пока нет
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
                        <span className={styles.agentOff}>не подключён</span>
                      )}
                    </td>
                    <td className={styles.muted}>{formatDate(user.createdAt)}</td>
                    <td className={styles.actions}>
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        disabled={isSelf || deletingId === user.id}
                        title={isSelf ? "Нельзя удалить себя" : "Удалить"}
                        onClick={() => void onDelete(user)}
                      >
                        {deletingId === user.id ? "…" : "Удалить"}
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
