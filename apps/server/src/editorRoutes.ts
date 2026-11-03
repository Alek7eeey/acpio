import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  findDeclaration,
  formatText,
  lintFile,
  listEntries,
  readText,
  resolveImports,
  resolveSpecifier,
  toolStatus,
  writeText,
  type ToolPreference,
} from "./services/editorFs.js";
import { getSettings } from "./services/settings.js";
import { attachTypeScriptServer } from "./services/lspBridge.js";

const treeQuery = z.object({ root: z.string().min(1), path: z.string().default("") });
const fileQuery = z.object({ root: z.string().min(1), path: z.string().min(1) });
const writeBody = z.object({ root: z.string().min(1), path: z.string().min(1), text: z.string() });
const resolveBody = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  spec: z.string().min(1),
});

const declarationBody = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  spec: z.string().min(1),
  name: z.string().min(1),
});

const importsBody = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
});

function fail(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  const message = err instanceof Error ? err.message : "editor request failed";
  return reply.code(400).send({ error: message });
}

/** Which copy of each tool the settings ask for — the pane never decides alone. */
async function toolPreferences(): Promise<
  Record<"typescript" | "oxlint" | "oxfmt", ToolPreference>
> {
  const settings = await getSettings();
  return {
    typescript: settings.editorToolTypescript,
    oxlint: settings.editorToolOxlint,
    oxfmt: settings.editorToolOxfmt,
  };
}

/**
 * Editor spike: a file tree, file IO, oxlint markers and one TypeScript language
 * server per pane. Everything here is read/write of the local disk, so the pane
 * can only ever see folders the user could open themselves.
 */
export async function registerEditorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/editor/tree", async (req, reply) => {
    try {
      const q = treeQuery.parse(req.query);
      return { root: q.root, path: q.path, entries: await listEntries(q.root, q.path) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/api/editor/file", async (req, reply) => {
    try {
      const q = fileQuery.parse(req.query);
      return await readText(q.root, q.path);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put("/api/editor/file", async (req, reply) => {
    try {
      const body = writeBody.parse(req.body);
      await writeText(body.root, body.path, body.text);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/editor/lint", async (req, reply) => {
    try {
      const body = fileQuery.parse(req.body);
      const prefs = await toolPreferences();
      return await lintFile(body.root, body.path, prefs.oxlint);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Ctrl+click on `import ... from "./x"`: the language server sometimes answers
  // nothing for a specifier, and the file is still right there on disk.
  app.post("/api/editor/resolve", async (req, reply) => {
    try {
      const body = resolveBody.parse(req.body);
      return { path: await resolveSpecifier(body.root, body.path, body.spec) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // The language server cannot say where a name is declared when it never
  // resolved the specifier: the project's compiler can, syntax tree and all.
  app.post("/api/editor/declaration", async (req, reply) => {
    try {
      const body = declarationBody.parse(req.body);
      return { at: await findDeclaration(body.root, body.path, body.spec, body.name) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // What the pane hands tsserver besides the file itself: without its imports
  // in the program, every cross-file definition answers with the import line.
  app.post("/api/editor/imports", async (req, reply) => {
    try {
      const body = importsBody.parse(req.body);
      return { paths: await resolveImports(body.root, body.path) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // The buffer goes over the wire: a format is one undoable edit in the pane,
  // not a disk round-trip that could race a save.
  app.post("/api/editor/format", async (req, reply) => {
    try {
      const body = writeBody.parse(req.body);
      const prefs = await toolPreferences();
      return await formatText(body.root, body.path, body.text, prefs.oxfmt);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // `path` decides: the tools of a file live in the folder it belongs to, not in
  // the folder the pane happens to be opened on.
  app.get("/api/editor/tools", async (req, reply) => {
    try {
      const q = z.object({ root: z.string().min(1), path: z.string().default("") }).parse(req.query);
      return toolStatus(q.root, q.path, await toolPreferences());
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/ws/editor/lsp", { websocket: true }, (socket, req) => {
    const query = req.query as { root?: string; project?: string } | undefined;
    const root = query?.root;
    if (!root) {
      socket.close();
      return;
    }
    // The language server starts in the folder the file's project lives in, so a
    // pane opened on a repository above `web/` still sees `web/tsconfig.json`.
    void toolPreferences().then(
      (prefs) => attachTypeScriptServer(socket, root, prefs.typescript, query?.project ?? ""),
      () => socket.close(),
    );
  });
}
