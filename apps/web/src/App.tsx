import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAppStore } from "./lib/store";
import { I18nProvider } from "./lib/i18n";
import { installMessageHotkeys } from "./lib/messageHotkeys";
import { useSessionSocket } from "./lib/useSessionSocket";
import { AppShell } from "./components/AppShell";
import { AgentGate, AgentOfflineWarning } from "./components/AgentGate";
import { BootSplash } from "./components/BootSplash";
import { ToastHost } from "./components/ToastHost";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { RemoteKeyGate } from "./components/RemoteKeyGate";
import { api } from "./lib/api";

export function App() {
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const loading = useAppStore((s) => s.loading);
  const showBootSplash = useAppStore((s) => s.settings.showBootSplash);
  const agentGateDismissed = useAppStore((s) => s.agentGateDismissed);
  const [splashVisible, setSplashVisible] = useState(true);
  const [remoteLock, setRemoteLock] = useState<"unknown" | "locked" | "open">("unknown");

  useEffect(() => {
    let cancelled = false;
    void api
      .remoteAccessStatus()
      .then((s) => {
        if (cancelled) return;
        setRemoteLock(s.required && !s.unlocked ? "locked" : "open");
      })
      .catch(() => {
        if (!cancelled) setRemoteLock("open");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (remoteLock !== "open") return;
    void loadBootstrap();
  }, [loadBootstrap, remoteLock]);

  useEffect(() => installMessageHotkeys(), []);

  useSessionSocket(activeSessionId, remoteLock === "open" && !loading);

  const onSplashDone = useCallback(() => setSplashVisible(false), []);

  const ready = remoteLock === "open";
  const app =
    !ready || (loading && splashVisible && showBootSplash) ? null : (
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<ChatPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Route>
      </Routes>
    );

  const splashBlocking = splashVisible && showBootSplash;

  return (
    <I18nProvider>
      {remoteLock === "locked" ? <RemoteKeyGate onUnlocked={() => setRemoteLock("open")} /> : null}
      {app}
      <ToastHost />
      {ready && splashVisible && showBootSplash && (
        <BootSplash ready={!loading} onDone={onSplashDone} />
      )}
      {ready && !loading && !splashBlocking && !agentGateDismissed ? <AgentGate /> : null}
      {ready && !loading && !splashBlocking && agentGateDismissed ? <AgentOfflineWarning /> : null}
    </I18nProvider>
  );
}
