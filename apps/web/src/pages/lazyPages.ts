import { lazy } from "react";

/**
 * The pages that are not the chat, loaded on arrival.
 *
 * The editor is the whole CodeMirror suite (the merge view, the legacy modes,
 * the LSP client) — megabytes of sources that nobody needs to read a chat. The
 * settings, tasks and board pages come along for the same reason: they are one
 * navigation away, and the bundle of a self-hosted app is paid for on every
 * cold load. Chat itself stays in the main chunk: it is the landing page.
 *
 * The route table in `App.tsx` and the shell that actually renders the pages
 * (`AppShell`, which has no `<Outlet/>`) both point here, so a navigation
 * fetches each chunk once.
 */
export const LazyEditorPage = lazy(() =>
  import("./EditorPage").then((m) => ({ default: m.EditorPage })),
);
export const LazySettingsPage = lazy(() =>
  import("./SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
export const LazyTasksPage = lazy(() =>
  import("./TasksPage").then((m) => ({ default: m.TasksPage })),
);
export const LazyBoardPage = lazy(() =>
  import("./BoardPage").then((m) => ({ default: m.BoardPage })),
);
