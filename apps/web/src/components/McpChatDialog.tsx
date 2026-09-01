import { useState } from "react";
import { Link } from "react-router-dom";
import { isMcpServerAttached, mcpServerEndpoint } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { settingsPath } from "../lib/settingsNav";
import { mcpTypeMessageKey } from "../lib/mcpUi";
import { AppDialog } from "./AppDialog";
import modal from "./Modal.module.css";
import styles from "./McpChatDialog.module.css";

/**
 * Per-chat MCP picker: which globally-enabled MCP servers attach to THIS
 * chat's agent. Toggling persists `sessions.mcpDisabledIds` and restarts the
 * chat's agent (resume keeps history; the new list is passed to the session).
 */
export function McpChatDialog({
  open,
  sessionId,
  mcpDisabledIds,
  onClose,
}: {
  open: boolean;
  sessionId: string | null;
  mcpDisabledIds: string[] | undefined;
  onClose: () => void;
}) {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const setSessionFlags = useAppStore((s) => s.setSessionFlags);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!open || !sessionId) return null;

  const servers = (settings.mcpServers ?? []).filter(isMcpServerAttached);
  const disabled = new Set(mcpDisabledIds ?? []);

  const toggle = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    const next = new Set(disabled);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    try {
      await setSessionFlags(sessionId, { mcpDisabledIds: [...next] });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppDialog
      title={t("chat.mcpDialogTitle")}
      description={t("chat.mcpDialogDesc")}
      onClose={onClose}
      actions={
        <button type="button" className={modal.ghost} onClick={onClose}>
          {t("common.cancel")}
        </button>
      }
    >
      {servers.length === 0 ? (
        <p className={styles.hint}>{t("chat.mcpDialogNone")}</p>
      ) : (
        <div className={styles.list}>
          {servers.map((s) => {
            const isOn = !disabled.has(s.id);
            return (
              <div key={s.id} className={styles.row}>
                <span className={styles.rowName} title={mcpServerEndpoint(s)}>
                  {s.name}
                </span>
                <span className={styles.rowType}>
                  {t(mcpTypeMessageKey(s.type))}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  className={`${styles.toggle} ${isOn ? styles.toggleOn : ""}`}
                  disabled={busyId === s.id}
                  onClick={() => void toggle(s.id)}
                >
                  <span className={styles.toggleKnob} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className={styles.foot}>
        <Link to={settingsPath("agent", "mcp")} onClick={onClose}>
          {t("chat.mcpManage")}
        </Link>
      </p>
    </AppDialog>
  );
}
