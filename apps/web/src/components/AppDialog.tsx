import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./Modal.module.css";

type AppDialogProps = {
  title: string;
  description?: string;
  children?: ReactNode;
  onClose: () => void;
  actions: ReactNode;
};

export function AppDialog({ title, description, children, onClose, actions }: AppDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("input,button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`${styles.modal} ${styles.dialogCompact}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        {description && <p className={styles.muted}>{description}</p>}
        {children}
        <div className={styles.actions}>{actions}</div>
      </div>
    </div>
  );
}
