/** Thin client for the editor spike routes; keeps the same error shape as `api.ts`. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      // keep raw text
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export type EditorEntry = { name: string; path: string; dir: boolean };

export type LintItem = {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  severity: "error" | "warning" | "info";
  source: string;
};

/** A tool the pane runs: the project's own copy, ours, or nothing the project uses. */
export type ToolStatus = { version: string; source: "project" | "bundled" | "missing" };

export const editorApi = {
  tree: (root: string, path: string) =>
    request<{ entries: EditorEntry[] }>(
      `/api/editor/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
  file: (root: string, path: string) =>
    request<{ path: string; text: string }>(
      `/api/editor/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
  save: (root: string, path: string, text: string) =>
    request<{ ok: boolean }>("/api/editor/file", {
      method: "PUT",
      body: JSON.stringify({ root, path, text }),
    }),
  /**
   * The formatter returns the whole buffer; the pane applies it as one edit.
   * `text: null` means the project does not format here, and `note` says why.
   */
  format: (root: string, path: string, text: string) =>
    request<{ text: string | null; note?: string }>("/api/editor/format", {
      method: "POST",
      body: JSON.stringify({ root, path, text }),
    }),
  /** Per file: the tools of a file live in the folder it belongs to. */
  tools: (root: string, path: string) =>
    request<{
      tools: Record<"typescript" | "oxlint" | "oxfmt", ToolStatus>;
      project: string;
    }>(`/api/editor/tools?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  /** The file a relative import points at, when the language server has no answer. */
  resolve: async (root: string, path: string, spec: string): Promise<string | null> => {
    const res = await request<{ path: string | null }>("/api/editor/resolve", {
      method: "POST",
      body: JSON.stringify({ root, path, spec }),
    });
    return res.path;
  },
  lint: async (root: string, path: string): Promise<{ items: LintItem[]; note?: string }> => {
    const res = await request<{
      diagnostics: Array<Omit<LintItem, "source"> & { file: string }>;
      note?: string;
    }>("/api/editor/lint", {
      method: "POST",
      body: JSON.stringify({ root, path }),
    });
    return { items: res.diagnostics.map((d) => ({ ...d, source: "oxlint" })), note: res.note };
  },
};
