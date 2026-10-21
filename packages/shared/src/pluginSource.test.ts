import { describe, expect, it } from "vitest";
import { pluginSourceKind, resolvePluginSource } from "./pluginSource.js";

const opts = { cwd: "C:/acpio", home: "C:/Users/dev" };

describe("pluginSourceKind", () => {
  it("calls a Windows path a path, not a URL", () => {
    // `new URL("C:\\plugins\\config.json")` succeeds with the scheme `c:` — the
    // reason the kind is read off the string instead of parsed.
    expect(pluginSourceKind("C:\\plugins\\config.json")).toBe("path");
    expect(pluginSourceKind("C:/plugins/config.json")).toBe("path");
    expect(pluginSourceKind("./config.json")).toBe("path");
    expect(pluginSourceKind("/etc/acpio/plugins.json")).toBe("path");
    expect(pluginSourceKind("~/plugins.json")).toBe("path");
  });

  it("calls http, https and file URL", () => {
    expect(pluginSourceKind("https://example.com/plugins.json")).toBe("url");
    expect(pluginSourceKind("HTTP://example.com/plugins.json")).toBe("url");
    expect(pluginSourceKind("file:///C:/plugins/config.json")).toBe("url");
  });
});

describe("resolvePluginSource", () => {
  it("resolves the config source itself against the cwd", () => {
    expect(resolvePluginSource("plugins.json", opts)).toEqual({
      kind: "path",
      path: "C:/acpio/plugins.json",
    });
    expect(resolvePluginSource("data/plugins/config.json", opts)).toEqual({
      kind: "path",
      path: "C:/acpio/data/plugins/config.json",
    });
  });

  it("keeps an absolute path and expands a path that escapes", () => {
    expect(resolvePluginSource("D:/shared/plugins.json", opts)).toEqual({
      kind: "path",
      path: "D:/shared/plugins.json",
    });
    expect(resolvePluginSource("../other/plugins.json", opts)).toEqual({
      kind: "path",
      path: "C:/other/plugins.json",
    });
  });

  it("expands ~ to the server user's home", () => {
    expect(resolvePluginSource("~", opts)).toEqual({ kind: "path", path: "C:/Users/dev" });
    expect(resolvePluginSource("~/plugins/config.json", opts)).toEqual({
      kind: "path",
      path: "C:/Users/dev/plugins/config.json",
    });
  });

  it("reads a file URL as a path", () => {
    expect(resolvePluginSource("file:///C:/plugins/config.json", opts)).toEqual({
      kind: "path",
      path: "C:/plugins/config.json",
    });
    expect(resolvePluginSource("file:///etc/acpio/plugins.json", opts)).toEqual({
      kind: "path",
      path: "/etc/acpio/plugins.json",
    });
  });

  it("resolves an entry against the manifest it was written in", () => {
    const fileBase = { kind: "path", path: "C:/plugins/config.json" } as const;
    expect(resolvePluginSource("./dist/server.js", { ...opts, base: fileBase })).toEqual({
      kind: "path",
      path: "C:/plugins/dist/server.js",
    });
    expect(resolvePluginSource("../shared/server.js", { ...opts, base: fileBase })).toEqual({
      kind: "path",
      path: "C:/shared/server.js",
    });
    // An entry may be absolute or a URL even when the manifest is a file.
    expect(resolvePluginSource("https://cdn.example.com/p/server.js", { ...opts, base: fileBase })).toEqual({
      kind: "url",
      url: "https://cdn.example.com/p/server.js",
    });

    const urlBase = { kind: "url", url: "https://example.com/cfg/config.json" } as const;
    expect(resolvePluginSource("./dist/server.js", { ...opts, base: urlBase })).toEqual({
      kind: "url",
      url: "https://example.com/cfg/dist/server.js",
    });
  });

  it("returns null for an empty source and throws on a broken URL", () => {
    expect(resolvePluginSource("   ", opts)).toBeNull();
    expect(() => resolvePluginSource("https://", opts)).toThrow();
  });
});
