import styles from "./ThemeToggle.module.css";

type Theme = "light" | "dark";

type ThemeToggleProps = {
  theme: Theme;
  onToggle: () => void;
  className?: string;
};

export function ThemeToggle({ theme, onToggle, className }: ThemeToggleProps) {
  return (
    <button
      type="button"
      className={`${styles.themeIconBtn} ${className ?? ""}`}
      data-mode={theme}
      aria-label={theme === "light" ? "Тёмная тема" : "Светлая тема"}
      title={theme === "light" ? "Тёмная тема" : "Светлая тема"}
      onClick={onToggle}
    >
      <span className={styles.themeGlyph} aria-hidden>
        <svg className={styles.themeSun} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M12 2.6v2" />
            <path d="M12 19.4v2" />
            <path d="M2.6 12h2" />
            <path d="M19.4 12h2" />
            <path d="M5.15 5.15l1.4 1.4" />
            <path d="M17.45 17.45l1.4 1.4" />
            <path d="M5.15 18.85l1.4-1.4" />
            <path d="M17.45 6.55l1.4-1.4" />
          </g>
        </svg>
        <svg className={styles.themeMoon} viewBox="0 0 24 24" fill="none">
          <path
            d="M20.2 13.2A7.8 7.8 0 1 1 10.8 3.8 6.4 6.4 0 0 0 20.2 13.2Z"
            fill="currentColor"
          />
        </svg>
      </span>
    </button>
  );
}
