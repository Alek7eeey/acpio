/** Live shell PTY stream for the session console panel (buffered in xterm until F5). */

export type ShellConsoleEvent =
  | { type: "output"; sessionId: string; text: string }
  | { type: "cleared"; sessionId: string };

type Listener = (event: ShellConsoleEvent) => void;

const listeners = new Set<Listener>();

export function subscribeShellConsole(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchShellConsole(event: ShellConsoleEvent) {
  for (const listener of listeners) listener(event);
}
