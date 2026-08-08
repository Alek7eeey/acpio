import { useState, type FormEvent } from "react";
import { AuthHero } from "../components/AuthHero";
import { ThemeToggle } from "../components/ThemeToggle";
import { useAppStore } from "../lib/store";
import styles from "./AuthPage.module.css";

type Mode = "login" | "register";

export function AuthPage() {
  const login = useAppStore((s) => s.login);
  const register = useAppStore((s) => s.register);
  const applyTheme = useAppStore((s) => s.applyTheme);
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "light";
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  });

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    applyTheme(next);
    setTheme(next);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError("Введите логин и пароль");
      return;
    }
    if (mode === "register" && password !== password2) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <header className={styles.cardTop}>
          <div className={styles.logo}>
            <span className={styles.logoMark}>ACP</span>
            <span>rocess</span>
          </div>
          <div className={styles.topActions}>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <button
              type="button"
              className={styles.topSwitch}
              onClick={() => {
                setMode((m) => (m === "login" ? "register" : "login"));
                setError(null);
              }}
            >
              {mode === "login" ? (
                <>
                  Нет аккаунта? <strong>Регистрация</strong>
                </>
              ) : (
                <>
                  Уже есть аккаунт? <strong>Войти</strong>
                </>
              )}
            </button>
          </div>
        </header>

        <div className={styles.columns}>
          <aside className={styles.visual} aria-hidden>
            <AuthHero className={styles.heroImg} />
          </aside>

          <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
            <div className={styles.formHead}>
              <h1>{mode === "login" ? "С возвращением!" : "Добро пожаловать!"}</h1>
              <p>{mode === "login" ? "Войдите в аккаунт" : "Создайте аккаунт"}</p>
            </div>

            <label className={styles.field}>
              <span>Логин</span>
              <input
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Введите логин"
                maxLength={64}
              />
            </label>

            <label className={styles.field}>
              <span>Пароль</span>
              <div className={styles.passwordWrap}>
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Введите пароль"
                  maxLength={200}
                />
                <button
                  type="button"
                  className={styles.eyeBtn}
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M3 3l18 18M10.5 10.7a2.5 2.5 0 0 0 3.0 3.1M9.9 5.1A10.5 10.5 0 0 1 12 4.8c5 0 9.3 3.2 10.7 7.5a11.4 11.4 0 0 1-3.2 4.5M6.1 6.3A11.3 11.3 0 0 0 1.3 12.3C2.7 16.6 7 19.8 12 19.8c1.4 0 2.7-.2 3.9-.7"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      />
                      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
                    </svg>
                  )}
                </button>
              </div>
            </label>

            {mode === "register" && (
              <label className={styles.field}>
                <span>Подтверждение пароля</span>
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  placeholder="Подтвердите пароль"
                  maxLength={200}
                />
              </label>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <button type="submit" className={styles.submit} disabled={busy}>
              {busy ? "…" : mode === "login" ? "Войти" : "Создать аккаунт"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
