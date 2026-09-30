import type { BuiltinHeaderConfig } from "@acpio/shared";
import { useT } from "../lib/i18n";
import styles from "./BuiltinHeadersEditor.module.css";

/**
 * Settings → Built-in agent → Headers: extra HTTP headers sent with every
 * request to this provider. `{{sessionId}}` in a value is replaced with the
 * chat's session id at request time. Rows are form state — everything lands
 * on Save like the rest of the page.
 */
export function BuiltinHeadersEditor({
  value,
  onChange,
}: {
  value: BuiltinHeaderConfig[];
  onChange: (next: BuiltinHeaderConfig[]) => void;
}) {
  const t = useT();
  const update = (index: number, patch: Partial<BuiltinHeaderConfig>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  return (
    <div className={styles.editor}>
      {value.map((row, index) => (
        // Index keys: a row has no stable id, and typing in a field must not
        // remount it mid-edit.
        <div key={index} className={styles.row}>
          <input
            className={styles.name}
            value={row.name}
            onChange={(e) => update(index, { name: e.target.value })}
            placeholder="x-opencode-session"
            spellCheck={false}
            autoComplete="off"
            aria-label={`${t("settings.builtinHeadersName")} ${index + 1}`}
          />
          <input
            className={styles.value}
            value={row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            placeholder="{{sessionId}}"
            spellCheck={false}
            autoComplete="off"
            aria-label={`${t("settings.builtinHeadersValue")} ${index + 1}`}
          />
          <button
            type="button"
            className={styles.remove}
            title={t("settings.builtinHeadersRemove")}
            aria-label={`${t("settings.builtinHeadersRemove")} ${index + 1}`}
            onClick={() => remove(index)}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className={styles.add} onClick={() => onChange([...value, { name: "", value: "" }])}>
        + {t("settings.builtinHeadersAdd")}
      </button>
    </div>
  );
}
