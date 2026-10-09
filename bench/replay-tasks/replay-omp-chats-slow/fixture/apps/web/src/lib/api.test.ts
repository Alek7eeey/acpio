// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}) {
  return {
    ok: (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: new Headers(init.headers),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function textResponse(text: string, init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}) {
  return {
    ok: (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: new Headers(init.headers),
    json: async () => {
      throw new SyntaxError("not json");
    },
    text: async () => text,
  };
}

let fetchMock: FetchMock;
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;
let anchorClickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
  anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  anchorClickSpy.mockRestore();
});

describe("request: success paths", () => {
  it("resolves parsed JSON for a GET request with credentials", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ theme: "dark" }));
    await expect(api.getSettings()).resolves.toEqual({ theme: "dark" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends a JSON body with Content-Type for mutations", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await api.updateSettings({ theme: "light" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ theme: "light" });
  });

  it("resolves undefined for a 204 response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(undefined, { status: 204 }));
    await expect(api.deleteSession("s1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("builds the search query string with q and optional limit", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api.searchMessages("hello");
    expect(fetchMock).toHaveBeenCalledWith("/api/search?q=hello", expect.anything());

    await api.searchMessages("hello", 10);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/search?q=hello&limit=10", expect.anything());
  });

  it("omits empty query params for listModels", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, provider: "cursor", models: [] }));
    await api.listModels();
    expect(fetchMock).toHaveBeenCalledWith("/api/agent/models", expect.anything());

    await api.listModels("cursor", { force: true });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/agent/models?provider=cursor&force=1",
      expect.anything(),
    );
  });
});

describe("request: error paths", () => {
  it("throws the JSON {error} message on a non-ok response", async () => {
    fetchMock.mockResolvedValue(textResponse('{"error":"session not found"}', { status: 404, statusText: "Not Found" }));
    await expect(api.getSession("s1")).rejects.toThrow("session not found");
  });

  it("throws the plain text body on a non-ok response without JSON", async () => {
    fetchMock.mockResolvedValue(textResponse("server exploded", { status: 500, statusText: "Internal Server Error" }));
    await expect(api.getSettings()).rejects.toThrow("server exploded");
  });

  it("falls back to statusText when the error body is empty", async () => {
    fetchMock.mockResolvedValue(textResponse("", { status: 503, statusText: "Service Unavailable" }));
    await expect(api.getSettings()).rejects.toThrow("Service Unavailable");
  });

  it("throws the JSON {error} message for downloadSessionExport failures", async () => {
    fetchMock.mockResolvedValue(textResponse('{"error":"export failed"}', { status: 400, statusText: "Bad Request" }));
    await expect(api.downloadSessionExport("s1", "md")).rejects.toThrow("export failed");
  });
});

describe("downloadSessionExport", () => {
  it("fetches ?format=json and downloads the decoded UTF-8 filename", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse("conversation", {
        headers: {
          "Content-Type": "text/markdown",
          "Content-Disposition": "attachment; filename*=UTF-8''%D0%B2%D1%8B%D0%B2%D0%BE%D0%B4.md",
        },
      }),
    );

    await api.downloadSessionExport("s1", "json");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/export?format=json",
      expect.objectContaining({ credentials: "include" }),
    );
    const clicked = anchorClickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(clicked.download).toBe("вывод.md");
    expect(clicked.href).toBe("blob:mock");
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });

  it("uses a default filename when Content-Disposition has no filename*=UTF-8''", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse("conversation", { headers: { "Content-Disposition": 'attachment; filename="chat.md"' } }),
    );

    await api.downloadSessionExport("s1", "md");

    const clicked = anchorClickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(clicked.download).toBe("chat-export.md");
  });

  it("uses a .json default filename for the json format", async () => {
    fetchMock.mockResolvedValue(jsonResponse("{}", { headers: { "Content-Type": "application/json" } }));

    await api.downloadSessionExport("s1", "json");

    const clicked = anchorClickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(clicked.download).toBe("chat-export.json");
  });

  it("decodes percent-encoded spaces in the filename", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse("x", {
        headers: { "Content-Disposition": "attachment; filename*=UTF-8''chat%20export.md" },
      }),
    );

    await api.downloadSessionExport("s1", "md");

    const clicked = anchorClickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(clicked.download).toBe("chat export.md");
  });
});

describe("saveSessionExportToServer", () => {
  it("POSTs {format, dir} when a directory is given", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, path: "/tmp", fileName: "a.md" }));
    await api.saveSessionExportToServer("s1", "json", "/tmp/exports");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/export");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ format: "json", dir: "/tmp/exports" });
  });

  it("POSTs only {format} when no directory is given", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, path: "/tmp", fileName: "a.md" }));
    await api.saveSessionExportToServer("s1", "md");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ format: "md" });
  });
});

describe("getExportDefaultDir", () => {
  it("GETs /api/export/default-dir and resolves {path}", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: "E:\\exports" }));
    await expect(api.getExportDefaultDir()).resolves.toEqual({ path: "E:\\exports" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/export/default-dir",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
