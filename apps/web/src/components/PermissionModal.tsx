import { useAppStore } from "../lib/store";
import { useT } from "../lib/i18n";
import styles from "./Modal.module.css";

export function PermissionModal() {
  const t = useT();
  const pending = useAppStore((s) => s.pendingPermission);
  const answerPermission = useAppStore((s) => s.answerPermission);
  if (!pending) return null;

  const options =
    (pending.payload.options as Array<{ optionId: string; name?: string; kind?: string }> | undefined) ??
    [];

  const buttons =
    options.length > 0
      ? [...options].sort((a, b) => {
          const rank = (o: { kind?: string; optionId: string }) => {
            if (o.kind === "allow_always" || /always/i.test(o.optionId)) return 0;
            if (o.kind === "allow_once" || /allow/i.test(o.optionId)) return 1;
            return 2;
          };
          return rank(a) - rank(b);
        })
      : [
          { optionId: "allow_always", name: t("common.always"), kind: "allow_always" },
          { optionId: "allow_once", name: t("common.allow"), kind: "allow_once" },
          { optionId: "reject_once", name: t("common.deny"), kind: "reject_once" },
        ];

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <h2>{t("permission.title")}</h2>
        <p className={styles.muted}>{t("permission.description")}</p>
        <pre className={styles.pre}>{JSON.stringify(pending.payload, null, 2)}</pre>
        <div className={styles.actions}>
          {buttons.map((opt) => {
            const isAllow = /allow/i.test(opt.kind ?? "") || /allow|once|always/i.test(opt.optionId);
            return (
              <button
                key={opt.optionId}
                type="button"
                className={isAllow ? styles.primary : undefined}
                onClick={() => void answerPermission(opt.optionId)}
              >
                {opt.name ?? opt.optionId}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
