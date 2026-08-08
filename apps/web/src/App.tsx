import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAppStore } from "./lib/store";
import { useSessionSocket } from "./lib/useSessionSocket";
import { AppShell } from "./components/AppShell";
import { BootSplash } from "./components/BootSplash";
import { AuthPage } from "./pages/AuthPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { GiteaPage } from "./pages/GiteaPage";

export function App() {
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const loading = useAppStore((s) => s.loading);
  const user = useAppStore((s) => s.user);
  const [splashVisible, setSplashVisible] = useState(true);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useSessionSocket(user ? activeSessionId : null, Boolean(user));

  const onSplashDone = useCallback(() => setSplashVisible(false), []);

  // Mount app under the splash so exit never leaves a blank tree.
  const app =
    loading && splashVisible ? null : !user ? (
      <AuthPage />
    ) : (
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
    <>
      {app}
      {splashVisible && <BootSplash ready={!loading} onDone={onSplashDone} />}
    </>
  );
}
