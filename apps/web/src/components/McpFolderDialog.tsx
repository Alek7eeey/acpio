import { useEffect, useState } from "react";
import {
  isMcpServerConfigured,
  mcpFolderConfig,
  mcpServerEndpoint,
  mcpServerInFolder,
  type McpServerConfig,
} from "@acpio/shared";
import { useT } from "../lib/i18n";
import { canonicalCwd } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import {
  mcpEnvConfigDraft,
  mcpRemoteConfigDraft,
  mcpTypeMessageKey,
  normalizeMcpDraft,
} from "../lib/mcpUi";
import { AppDialog } from "./AppDialog";
import { McpServerForm } from "./McpServerForm";
import { Toggle } from "./SettingRow";
import modal from "./Modal.module.css";
import styles from "./McpFolderDialog.module.css";

/**
 * Per-folder MCP overrides for one folder: switch individual servers on or off
 * for the chats opened in it — a server that is off globally included, so the
 * global list stays the only place a server is defined — and add servers that
 * exist only there. Persisted under `settings.mcpFolderConfigs[cwd]`; the
 * server restarts only the live chats whose effective list changed.
 */
export function McpFolderDialog({
  open,
  cwd,
  onClose,
}: {
  open: boolean;
  cwd: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const projectMcp = useAppStore((s) => s.projectMcp);
  const refreshProjectMcp = useAppStore((s) => s.refreshProjectMcp);
  const [draft, setDraft] = useState<McpServerConfig | null>(null);
  const [busy, setBusy] = useState(false);

  // The folder's own MCP files change on disk while the dialog is closed, so
  // rescan whenever it opens.
  useEffect(() => {
    if (open && cwd) void refreshProjectMcp(cwd);
  }, [open, cwd, refreshProjectMcp]);

  if (!open || !cwd) return null;

  const key = canonicalCwd(cwd);
  const config = mcpFolderConfig(settings, key);
  const overrides = config?.overrides ?? {};
  // Every app-configured server is listed, including the ones switched off
  // globally: a folder may turn one on for itself.
  const globals = (settings.mcpServers ?? []).filter(isMcpServerConfigured);
  const own = config?.servers ?? [];
  // Discovered servers already named by an app-configured one never attach
  // (see effectiveMcpServers), so they are not offered here either.
  const appNames = new Set([...globals, ...own].map((s) => s.name));
  const discovered = (projectMcp[key]?.servers ?? []).filter(
    (s) => isMcpServerConfigured(s) && !appNames.has(s.name),
  );
  const warnings = projectMcp[key]?.warnings ?? [];

  const persist = async (next: {
    overrides: Record<string, boolean>;
    servers: McpServerConfig[];
  }) => {
    const map = { ...(settings.mcpFolderConfigs ?? {}) };
    // A folder that no longer overrides anything is dropped, so the map stays
    // sparse and a later global change is not blocked by a stale entry.
    if (!Object.keys(next.overrides).length && !next.servers.length) delete map[key];
    else map[key] = next;
    setBusy(true);
    try {
      await saveSettings({ mcpFolderConfigs: map });
    } finally {
      setBusy(false);
    }
  };

  /** Folder switch for one server; matching its own state again drops the row. */
  const setServerOn = (server: McpServerConfig, on: boolean) => {
    const next = { ...overrides };
    if (on === Boolean(server.enabled)) delete next[server.id];
    else next[server.id] = on;
    void persist({ overrides: next, servers: own });
  };

  const setOwnEnabled = (id: string, enabled: boolean) => {
    void persist({
      overrides: { ...overrides },
      servers: own.map((s) => (s.id === id ? { ...s, enabled } : s)),
    });
  };

  const removeOwn = (id: string) => {
    void persist({
      overrides: { ...overrides },
      servers: own.filter((s) => s.id !== id),
    });
  };

  const saveOwn = () => {
    if (!draft) return;
    const next = normalizeMcpDraft(draft);
    if (!next) return;
    void persist({
      overrides: { ...overrides },
      servers: own.some((s) => s.id === next.id)
        ? own.map((s) => (s.id === next.id ? next : s))
        : [...own, next],
    });
    setDraft(null);
  };

  return (
    <AppDialog
      title={t("chat.mcpFolderTitle")}
      description={t("chat.mcpFolderDesc", { path: key })}
      onClose={onClose}
      actions={
        <button type="button" className={modal.ghost} onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <h3 className={styles.sectionTitle}>{t("chat.mcpFolderGlobal")}</h3>
      {globals.length === 0 ? (
        <p className={styles.hint}>{t("chat.mcpDialogNone")}</p>
      ) : (
        <div className={styles.list}>
          {globals.map((s) => (
            <div key={s.id} className={styles.row}>
              <span className={styles.rowName} title={mcpServerEndpoint(s)}>
                {s.name}
              </span>
              {s.enabled ? null : (
                <span className={styles.rowOff}>{t("chat.mcpFolderGlobalOff")}</span>
              )}
              <span className={styles.rowType}>{t(mcpTypeMessageKey(s.type))}</span>
              <Toggle
                checked={mcpServerInFolder(config, s)}
                onChange={(v) => setServerOn(s, v)}
                label={s.name}
              />
            </div>
          ))}
        </div>
      )}

      <h3 className={styles.sectionTitle}>{t("chat.mcpFolderOwn")}</h3>
      {own.length === 0 ? (
        <p className={styles.hint}>{t("chat.mcpFolderOwnEmpty")}</p>
      ) : (
        <div className={styles.list}>
          {own.map((s) => (
            <div key={s.id} className={styles.row}>
              <span className={styles.rowName} title={mcpServerEndpoint(s)}>
                {s.name}
              </span>
              <span className={styles.rowType}>{t(mcpTypeMessageKey(s.type))}</span>
              <Toggle
                checked={s.enabled}
                onChange={(v) => setOwnEnabled(s.id, v)}
                label={s.name}
              />
              <button
                type="button"
                className={styles.rowBtn}
                disabled={busy}
                onClick={() =>
                  setDraft({
                    ...s,
                    remoteConfig: mcpRemoteConfigDraft(s),
                    envConfig: mcpEnvConfigDraft(s),
                  })
                }
              >
                {t("common.edit")}
              </button>
              <button
                type="button"
                className={styles.rowBtn}
                disabled={busy}
                onClick={() => removeOwn(s.id)}
              >
                {t("common.delete")}
              </button>
            </div>
          ))}
        </div>
      )}

      <h3 className={styles.sectionTitle}>{t("chat.mcpFolderFiles")}</h3>
      {discovered.length === 0 ? (
        <p className={styles.hint}>{t("chat.mcpFolderFilesEmpty")}</p>
      ) : (
        <div className={styles.list}>
          {discovered.map((s) => (
            <div key={s.id} className={styles.row}>
              <span className={styles.rowName} title={mcpServerEndpoint(s)}>
                {s.name}
              </span>
              <span className={styles.rowType}>{t(mcpTypeMessageKey(s.type))}</span>
              <Toggle
                checked={mcpServerInFolder(config, s)}
                onChange={(v) => setServerOn(s, v)}
                label={s.name}
              />
            </div>
          ))}
        </div>
      )}
      {warnings.length > 0 ? (
        <ul className={styles.warnings}>
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {draft ? (
        <McpServerForm
          draft={draft}
          onChange={setDraft}
          onSave={saveOwn}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <button
          type="button"
          className={styles.addBtn}
          onClick={() =>
            setDraft({
              id: "",
              name: "",
              enabled: true,
              type: "local",
              url: "",
              remoteConfig: '{\n  "headers": {\n    "Authorization": "Bearer "\n  }\n}',
            })
          }
        >
          + {t("chat.mcpFolderAdd")}
        </button>
      )}

      <p className={styles.foot}>{t("chat.mcpFolderHint")}</p>
    </AppDialog>
  );
}
