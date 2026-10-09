import type { McpServerConfig } from "@acpio/shared";
import { isMcpServerConfigured, mcpCommandNeedsAbsolute } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { OptionPicker } from "./OptionPicker";
import styles from "./McpServerForm.module.css";

/**
 * Editor for one MCP server draft (name, transport, transport fields). Shared
 * by Settings → MCP and the per-folder MCP dialog so both save the same shape;
 * the caller owns the draft state and decides where the result is persisted.
 */
export function McpServerForm({
  draft,
  onChange,
  onSave,
  onCancel,
  saveLabel,
}: {
  draft: McpServerConfig;
  onChange: (next: McpServerConfig) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel?: string;
}) {
  const t = useT();
  const canSave = draft.name.trim().length > 0 && isMcpServerConfigured(draft);

  return (
    <div className={styles.form}>
      <input
        className={styles.input}
        placeholder={t("settings.mcpName")}
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
      />
      <OptionPicker
        variant="block"
        placement="down"
        menuTitle={t("settings.mcpType")}
        value={draft.type}
        onChange={(v) =>
          onChange({
            ...draft,
            type: v === "stdio" ? "stdio" : v === "remote" ? "remote" : "local",
          })
        }
        options={[
          { value: "local", label: t("settings.mcpLocal") },
          { value: "remote", label: t("settings.mcpRemote") },
          { value: "stdio", label: t("settings.mcpStdio") },
        ]}
      />
      {draft.type === "stdio" ? (
        <>
          <input
            className={styles.input}
            placeholder={t("settings.mcpCommand")}
            value={draft.command ?? ""}
            onChange={(e) => onChange({ ...draft, command: e.target.value })}
          />
          {mcpCommandNeedsAbsolute(draft) ? (
            <span className={styles.fieldHint}>{t("settings.mcpCommandHint")}</span>
          ) : null}
          <input
            className={styles.input}
            placeholder={t("settings.mcpArgs")}
            value={(draft.args ?? []).join(" ")}
            onChange={(e) =>
              onChange({ ...draft, args: e.target.value.split(/\s+/).filter(Boolean) })
            }
          />
          <label className={styles.jsonBlock}>
            <span className={styles.jsonLabel}>{t("settings.mcpEnv")}</span>
            <textarea
              className={styles.jsonInput}
              rows={6}
              spellCheck={false}
              placeholder={'{\n  "API_KEY": ""\n}'}
              value={draft.envConfig ?? ""}
              onChange={(e) => onChange({ ...draft, envConfig: e.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <input
            className={styles.input}
            placeholder={t("settings.mcpUrl")}
            value={draft.url ?? ""}
            onChange={(e) => onChange({ ...draft, url: e.target.value })}
          />
          {draft.type !== "remote" && (
            <label className={styles.tlsRow}>
              <input
                type="checkbox"
                checked={draft.insecureTls === true}
                onChange={(e) => onChange({ ...draft, insecureTls: e.target.checked })}
              />
              <span>{t("settings.mcpInsecureTls")}</span>
              <span className={styles.tlsHint}>{t("settings.mcpInsecureTlsHint")}</span>
            </label>
          )}
          <label className={styles.jsonBlock}>
            <span className={styles.jsonLabel}>{t("settings.mcpRemoteConfig")}</span>
            <textarea
              className={styles.jsonInput}
              rows={8}
              spellCheck={false}
              placeholder={'{\n  "headers": {\n    "Authorization": "Bearer ..."\n  }\n}'}
              value={draft.remoteConfig ?? ""}
              onChange={(e) => onChange({ ...draft, remoteConfig: e.target.value })}
            />
          </label>
        </>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.cancelBtn} onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className={styles.saveBtn} disabled={!canSave} onClick={onSave}>
          {saveLabel ?? t("common.save")}
        </button>
      </div>
    </div>
  );
}
