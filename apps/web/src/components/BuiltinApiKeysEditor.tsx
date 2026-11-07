import { BUILTIN_MAX_PROVIDER_KEYS } from "@acpio/shared";
import { useT } from "../lib/i18n";
import styles from "./BuiltinApiKeysEditor.module.css";

/**
 * Settings → Built-in agent → Providers → keys: the pool a provider is called
 * with. The order is the rotation order (first key first), and each row is a
 * password field so a key is never on screen by accident. Rows are form state —
 * everything lands on Save like the rest of the page.
 */
export function BuiltinApiKeysEditor({
  label,
  value,
  onChange,
}: {
  /** The provider's display name: every card renders one, and a key field has
   *  to be findable by name (a screen reader hears the whole label). */
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const update = (index: number, key: string) =>
    onChange(value.map((row, i) => (i === index ? key : row)));
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  return (
    <div className={styles.editor}>
      {value.map((key, index) => (
        // Index keys: a row has no stable id, and typing in a field must not
        // remount it mid-edit.
        <div key={index} className={styles.row}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => update(index, e.target.value)}
            placeholder="sk-…"
            aria-label={`${label} · ${t("settings.builtinKeyTitle")} ${index + 1}`}
          />
          <button
            type="button"
            className={styles.remove}
            title={t("settings.builtinKeysRemove")}
            aria-label={`${label} · ${t("settings.builtinKeysRemove")} ${index + 1}`}
            onClick={() => remove(index)}
          >
            ×
          </button>
        </div>
      ))}
      {/* The ceiling is the stored one, so the button says why it stops. */}
      {value.length < BUILTIN_MAX_PROVIDER_KEYS ? (
        <button type="button" className={styles.add} onClick={() => onChange([...value, ""])}>
          + {t("settings.builtinKeysAdd")}
        </button>
      ) : null}
    </div>
  );
}
