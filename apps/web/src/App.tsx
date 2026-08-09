import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAppStore } from "./lib/store";
import { I18nProvider } from "./lib/i18n";
import { useSessionSocket } from "./lib/useSessionSocket";
import { AppShell } from "./components/AppShell";
import { BootSplash } from "./components/BootSplash";
import { DashboardPage } from "./pages/DashboardPage";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { GiteaPage } from "./pages/GiteaPage";

export function App() {
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const loading = useAppStore((s) => s.loading);
  const [splashVisible, setSplashVisible] = useState(true);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useSessionSocket(activeSessionId, !loading);

  const onSplashDone = useCallback(() => setSplashVisible(false), []);

  const app =
    loading && splashVisible ? null : (
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="gitea" element={<GiteaPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    );

  return (
    <I18nProvider>
      {app}
      {splashVisible && <BootSplash ready={!loading} onDone={onSplashDone} />}
    </I18nProvider>
  );
}
