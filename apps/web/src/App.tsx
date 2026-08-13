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

export function App() {
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const loading = useAppStore((s) => s.loading);
  const showBootSplash = useAppStore((s) => s.settings.showBootSplash);
  const [splashVisible, setSplashVisible] = useState(true);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useSessionSocket(activeSessionId, !loading);

  const onSplashDone = useCallback(() => setSplashVisible(false), []);

  const app =
    loading && splashVisible && showBootSplash ? null : (
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    );

  return (
    <I18nProvider>
      {app}
      {splashVisible && showBootSplash && <BootSplash ready={!loading} onDone={onSplashDone} />}
    </I18nProvider>
  );
}
