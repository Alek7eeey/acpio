import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { attachTypeScriptServer, listEditorServers, type LspSocket } from "./lspBridge.js";

/** A pane as the bridge sees it: it only has to hear that it was closed. */
function pane(): LspSocket & { closed: number } {
  const socket = {
    closed: 0,
    readyState: 1,
    send: () => {},
    close() {
      socket.closed += 1;
    },
    on: () => socket,
  };
  return socket;
}

// The pane was opened before, its root is gone now: `spawn` fails with ENOENT,
// and that error event used to reach no listener and kill the whole server.
it("closes the pane instead of the server when the project folder is gone", async () => {
  const socket = pane();
  attachTypeScriptServer(socket, path.join(os.tmpdir(), `acpio-gone-${process.pid}-${Date.now()}`), "bundled");
  await vi.waitFor(() => expect(socket.closed).toBe(1));
  expect(listEditorServers()).toHaveLength(0);
});
