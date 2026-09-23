import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAppStore } from "./lib/store";
import { I18nProvider } from "./lib/i18n";
import { installMessageHotkeys } from "./lib/messageHotkeys";
import { useSessionSocket } from "./lib/useSessionSocket";
import { AppShell } from "./components/AppShell";
import { AgentGate, AgentOfflineWarning } from "./components/AgentGate";
import { BootSplash } from "./components/BootSplash";
import { NotificationPrompt } from "./components/NotificationPrompt";
import { ToastHost } from "./components/ToastHost";
import { BoardPage } from "./pages/BoardPage";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { RemoteKeyGate } from "./components/RemoteKeyGate";
import { api } from "./lib/api";
import { hasUnsavedComposerAttachments } from "./lib/composerDrafts";

export function App() {
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const loading = useAppStore((s) => s.loading);
  const showBootSplash = useAppStore((s) => s.settings.showBootSplash);
  const agentGateDismissed = useAppStore((s) => s.agentGateDismissed);
  const [splashVisible, setSplashVisible] = useState(true);

  const isLocalhost = typeof window !== "undefined" && (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "[::1]" ||
    window.location.hostname.endsWith(".localhost")
  );

  const [remoteLock, setRemoteLock] = useState<"unknown" | "locked" | "open">(
    isLocalhost ? "open" : "unknown"
  );

  useEffect(() => {
    if (isLocalhost) {
      setRemoteLock("open");
      return;
    }
    let cancelled = false;
    const unlock = (next: "locked" | "open") => {
      if (cancelled) return;
      window.clearTimeout(timer);
      setRemoteLock(next);
    };
    // If the status probe hangs, stay locked — do not fail open over LAN/VPN.
    const timer = window.setTimeout(() => {
      if (!cancelled) setRemoteLock((cur) => (cur === "unknown" ? "locked" : cur));
    }, 5000);
    void api
      .remoteAccessStatus()
      .then((s) => unlock(s.required && !s.unlocked ? "locked" : "open"))
      .catch(() => unlock("locked"));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isLocalhost]);

  useEffect(() => {
    if (remoteLock !== "open") return;
    void loadBootstrap();
  }, [loadBootstrap, remoteLock]);

  useEffect(() => installMessageHotkeys(), []);

  useSessionSocket(activeSessionId, remoteLock === "open" && !loading);

  useEffect(() => {
    // A reload costs nothing the server owns: the running turn, the queue the
    // server already drains, a parked question, and now the composer drafts too
    // (persisted into app settings, restored on boot). What still cannot be
    // rebuilt from the tab alone are staged attachment chips — uploaded blobs no
    // message references yet — so only those justify the warning.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const state = useAppStore.getState();
      if (state.promptQueue.length === 0 && !hasUnsavedComposerAttachments()) return;
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
    checkingRemote || !ready ? null : (
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<ChatPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="board/:boardId" element={<BoardPage />} />
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
      {ready && !loading && !splashBlocking && agentGateDismissed ? <NotificationPrompt /> : null}
    </I18nProvider>
  );
}
