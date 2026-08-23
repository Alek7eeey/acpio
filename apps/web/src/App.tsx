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
    const unlock = (next: "locked" | "open") => {
      if (cancelled) return;
      window.clearTimeout(timer);
      setRemoteLock(next);
    };
    // If the status probe hangs (proxy down, flaky tunnel), don't leave a blank page.
    const timer = window.setTimeout(() => {
      if (!cancelled) setRemoteLock((cur) => (cur === "unknown" ? "open" : cur));
    }, 5000);
    void api
      .remoteAccessStatus()
      .then((s) => unlock(s.required && !s.unlocked ? "locked" : "open"))
      .catch(() => unlock("open"));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (remoteLock !== "open") return;
    void loadBootstrap();
  }, [loadBootstrap, remoteLock]);

  useEffect(() => installMessageHotkeys(), []);

  useSessionSocket(activeSessionId, remoteLock === "open" && !loading);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const state = useAppStore.getState();
      const busy =
        state.sessions.some((s) => s.status === "running" || s.status === "waiting") ||
        state.activeSession?.status === "running" ||
        state.activeSession?.status === "waiting";
      if (!busy) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const onSplashDone = useCallback(() => setSplashVisible(false), []);

  const checkingRemote = remoteLock === "unknown";
  const ready = remoteLock === "open";
  const splashBlocking = splashVisible && showBootSplash;
  const app =
    checkingRemote || !ready || (loading && splashBlocking) ? null : (
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<ChatPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Route>
      </Routes>
    );

  const showSplash = (checkingRemote || ready) && splashBlocking;

  return (
    <I18nProvider>
      {remoteLock === "locked" ? <RemoteKeyGate onUnlocked={() => setRemoteLock("open")} /> : null}
      {app}
      <ToastHost />
      {showSplash ? <BootSplash ready={ready && !loading} onDone={onSplashDone} /> : null}
      {ready && !loading && !splashBlocking && !agentGateDismissed ? <AgentGate /> : null}
      {ready && !loading && !splashBlocking && agentGateDismissed ? <AgentOfflineWarning /> : null}
    </I18nProvider>
  );
}
