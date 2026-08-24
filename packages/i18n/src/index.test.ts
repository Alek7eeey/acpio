import { describe, it, expect } from "vitest";
import type { AppLocale } from "@acprocess/shared";
import {
  SUPPORTED_LOCALES,
  defaultSessionTitle,
  defaultThemeName,
  errorMessage,
  normalizeLocale,
  parseAcceptLanguage,
  t,
  type ErrorCode,
} from "@acprocess/i18n";

describe("normalizeLocale", () => {
  it.each<[string | null | undefined, AppLocale]>([
    [undefined, "en"],
    [null, "en"],
    ["", "en"],
    ["ru", "ru"],
    ["ru-RU", "ru"],
    ["ru-ru", "ru"],
    ["en", "en"],
    ["en-US", "en"],
    ["en-GB", "en"],
    ["EN", "en"],
    [" EN ", "en"],
    ["EN-us", "en"],
    ["fr", "en"],
    ["de-DE", "en"],
    ["zh-CN", "en"],
  ])("normalizeLocale(%j) -> %s", (raw, expected) => {
    expect(normalizeLocale(raw)).toBe(expected);
  });
});

describe("parseAcceptLanguage", () => {
  it.each<[string | null | undefined, AppLocale]>([
    [undefined, "en"],
    [null, "en"],
    ["", "en"],
    ["en-US,en;q=0.9", "en"],
    ["ru-RU,ru;q=0.9,en;q=0.8", "ru"],
    ["fr-FR,fr;q=0.9,en;q=0.8", "en"],
    ["de,ru;q=0.5", "ru"],
    ["fr;q=0.9,es;q=0.8", "en"],
    ["zh-CN,en-US", "en"],
    ["*;q=0.1", "en"],
    ["ru, en", "ru"],
    ["fr-CH, fr;q=0.9, en;q=0.8, ru;q=0.7", "en"],
    ["en;q=0.9,ru;q=0.8", "en"],
    ["ru-RU, ru;q=0.9", "ru"],
    ["EN", "en"],
  ])("parseAcceptLanguage(%j) -> %s", (header, expected) => {
    expect(parseAcceptLanguage(header)).toBe(expected);
  });
});

describe("createTranslator — RU pluralization", () => {
  // ru defines common.userCount_one/_few/_many with distinct texts.
  it.each<[number, string]>([
    [0, "0 пользователей"],
    [1, "1 пользователь"],
    [2, "2 пользователя"],
    [3, "3 пользователя"],
    [4, "4 пользователя"],
    [5, "5 пользователей"],
    [10, "10 пользователей"],
    [11, "11 пользователей"],
    [12, "12 пользователей"],
    [14, "14 пользователей"],
    [15, "15 пользователей"],
    [21, "21 пользователь"],
    [22, "22 пользователя"],
    [25, "25 пользователей"],
    [101, "101 пользователь"],
    [102, "102 пользователя"],
    [111, "111 пользователей"],
    [114, "114 пользователей"],
  ])("ru common.userCount with count %i -> %s", (count, expected) => {
    expect(t("ru", "common.userCount", { count })).toBe(expected);
  });

  // The suffix is chosen from vars.count while interpolation uses {{seconds}}.
  it.each<[Record<string, string | number>, string]>([
    [{ count: 1, seconds: 1 }, "Думал 1 секунду"],
    [{ count: 2, seconds: 2 }, "Думал 2 секунды"],
    [{ count: 5, seconds: 5 }, "Думал 5 секунд"],
    [{ count: 21, seconds: 21 }, "Думал 21 секунду"],
    [{ count: 101, seconds: 101 }, "Думал 101 секунду"],
    [{ count: 1, seconds: 42 }, "Думал 42 секунду"],
    [{ count: 5, seconds: 1 }, "Думал 1 секунд"],
  ])("ru common.thoughtFor with %j -> %s", (vars, expected) => {
    expect(t("ru", "common.thoughtFor", vars)).toBe(expected);
  });

  it("accepts a numeric string count", () => {
    expect(t("ru", "common.userCount", { count: "2" })).toBe("2 пользователя");
  });

  it.each<[string | number, string]>([
    [1, "В очереди: 1"],
    [5, "В очереди: 5"],
    [100, "В очереди: 100"],
    ["7", "В очереди: 7"],
  ])("ru chat.queueCount has no plural forms — base key used for count %s -> %s", (count, expected) => {
    expect(t("ru", "chat.queueCount", { count })).toBe(expected);
  });

  it("without a count var, plural logic is skipped — base key is missing so the key itself is returned", () => {
    expect(t("ru", "common.userCount")).toBe("common.userCount");
  });
});

describe("createTranslator — EN always uses the base key", () => {
  it.each<[string | number, string]>([
    [0, "Queued: 0"],
    [1, "Queued: 1"],
    [2, "Queued: 2"],
    [5, "Queued: 5"],
    [100, "Queued: 100"],
    ["7", "Queued: 7"],
  ])("en chat.queueCount with count %s -> %s", (count, expected) => {
    expect(t("en", "chat.queueCount", { count })).toBe(expected);
  });

  it.each<[string | number]>([[1], [5]])(
    "en ignores _one/_other suffix keys even when they exist (common.userCount, count %s)",
    (count) => {
      expect(t("en", "common.userCount", { count })).toBe("common.userCount");
    },
  );

  it.each<[AppLocale, string]>([
    ["en", "3d"],
    ["ru", "3д"],
  ])("common.relativeDays keeps its base form in %s regardless of count", (locale, expected) => {
    expect(t(locale, "common.relativeDays", { count: 3 })).toBe(expected);
  });

  it("without vars, the template is returned untouched", () => {
    expect(t("en", "chat.queueCount")).toBe("Queued: {{count}}");
  });
});

describe("interpolation", () => {
  it("interpolates multiple vars ({{agent}} and {{status}})", () => {
    expect(t("en", "common.agentStatus", { agent: "cursor", status: "online" })).toBe(
      "Agent: cursor · online",
    );
  });

  it("interpolates multiple vars in ru too", () => {
    expect(t("ru", "common.agentStatus", { agent: "cursor", status: "online" })).toBe(
      "Агент: cursor · online",
    );
  });

  it("replaces a missing var with an empty string", () => {
    expect(t("en", "common.agentStatus", { agent: "x" })).toBe("Agent: x · ");
  });

  it("interpolates a single var into chat.fileTooLarge", () => {
    expect(t("en", "chat.fileTooLarge", { name: "big.bin" })).toBe(
      "File «big.bin» exceeds 15 MB — skipped",
    );
    expect(t("ru", "chat.fileTooLarge", { name: "big.bin" })).toBe(
      "Файл «big.bin» больше 15 МБ — он пропущен",
    );
  });
});

describe("missing keys and locale resolution order", () => {
  it("returns the key itself when it is missing from en", () => {
    expect(t("en", "chat.doesNotExist")).toBe("chat.doesNotExist");
  });

  it("returns the key itself when it is missing from ru", () => {
    expect(t("ru", "chat.doesNotExist")).toBe("chat.doesNotExist");
  });

  it("returns the key itself when missing from ru even with a count var", () => {
    expect(t("ru", "chat.doesNotExist", { count: 5 })).toBe("chat.doesNotExist");
  });

  it("does not interpolate vars into a missing key", () => {
    expect(t("en", "nope.thing", { count: 1 })).toBe("nope.thing");
  });

  it("returns the key itself for a missing top-level section", () => {
    expect(t("en", "nosection.key")).toBe("nosection.key");
  });

  it("uses the ru text when both catalogs define the key (real pair: auth.welcome)", () => {
    expect(t("ru", "auth.welcome")).toBe("Добро пожаловать!");
  });

  it("uses the en text for the en locale on the same key", () => {
    expect(t("en", "auth.welcome")).toBe("Welcome!");
  });

  it("maps an unknown locale to the ru catalog", () => {
    expect(t("fr" as AppLocale, "auth.welcome")).toBe("Добро пожаловать!");
  });
});

describe("errorMessage", () => {
  it("resolves an error code in en", () => {
    expect(errorMessage("en", "invalidCredentials")).toBe("Invalid username or password");
  });

  it("resolves an error code in ru", () => {
    expect(errorMessage("ru", "invalidCredentials")).toBe("Неверный логин или пароль");
  });

  it("resolves a different code in en", () => {
    expect(errorMessage("en", "userNotFound")).toBe("User not found");
  });

  it("resolves a different code in ru", () => {
    expect(errorMessage("ru", "userNotFound")).toBe("Пользователь не найден");
  });

  it("interpolates vars into errors.pathOutsideCwd in en", () => {
    expect(errorMessage("en", "pathOutsideCwd", { path: "/tmp" })).toBe(
      "Path outside session cwd: /tmp",
    );
  });

  it("interpolates vars into errors.pathOutsideCwd in ru", () => {
    expect(errorMessage("ru", "pathOutsideCwd", { path: "/tmp" })).toBe(
      "Path outside session cwd: /tmp",
    );
  });

  it("interpolates two vars into errors.acpStartupTimeout in en", () => {
    expect(errorMessage("en", "acpStartupTimeout", { ms: 5000, details: "CLI missing" })).toBe(
      "ACP startup timeout (5000ms). Check CLI and model. CLI missing",
    );
  });

  it("interpolates two vars into errors.acpStartupTimeout in ru", () => {
    expect(errorMessage("ru", "acpStartupTimeout", { ms: 5000, details: "CLI missing" })).toBe(
      "Таймаут запуска ACP (5000ms). Проверьте CLI и модель. CLI missing",
    );
  });

  it("resolves an agent-related code", () => {
    expect(errorMessage("en", "agentNotConnected")).toBe("Connect an agent in Settings first");
  });

  it("returns English text for codes ru keeps untranslated", () => {
    expect(errorMessage("ru", "runtimeNotFound")).toBe("Runtime not found");
  });

  it("returns ru punctuation-rich text for errors.sessionBusy", () => {
    expect(errorMessage("ru", "sessionBusy")).toBe(
      "Сессия уже выполняет запрос. Нажмите «Стоп» и попробуйте снова.",
    );
  });

  it("returns errors.<code> for an unknown code", () => {
    expect(errorMessage("en", "notARealCode" as ErrorCode)).toBe("errors.notARealCode");
  });
});

describe("defaultSessionTitle / defaultThemeName", () => {
  it("defaultSessionTitle en", () => {
    expect(defaultSessionTitle("en")).toBe("New chat");
  });

  it("defaultSessionTitle ru", () => {
    expect(defaultSessionTitle("ru")).toBe("Новый чат");
  });

  it("defaultThemeName returns the key itself — common.newTheme is not in either catalog", () => {
    expect(defaultThemeName("en")).toBe("common.newTheme");
    expect(defaultThemeName("ru")).toBe("common.newTheme");
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("lists ru first, then en", () => {
    expect(SUPPORTED_LOCALES).toEqual(["ru", "en"]);
  });
});
