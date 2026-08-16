// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../lib/i18n";
import { ExportDialog } from "./ExportDialog";

const apiMock = vi.hoisted(() => ({
  getExportDefaultDir: vi.fn(async () => ({ path: "/srv/exports" })),
  downloadSessionExport: vi.fn(async () => undefined),
  saveSessionExportToServer: vi.fn(async () => ({
    ok: true,
    path: "/srv/exports/chat-export.json",
    fileName: "chat-export.json",
  })),
  openPath: vi.fn(async () => ({ ok: true, opened: "", kind: null })),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(props: { sessionId?: string | null; messageCount?: number } = {}) {
  const onClose = vi.fn();
  const view = render(
    <I18nProvider>
      <ExportDialog open sessionId="s1" onClose={onClose} {...props} />
    </I18nProvider>,
  );
  return { onClose, ...view };
}

describe("ExportDialog", () => {
  it("shows format and destination radios for a session with messages", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Экспорт чата" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Markdown (.md)" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "JSON" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Скачать" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Сохранить на сервере" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Скачать" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the empty state and a disabled action when messageCount is 0", () => {
    renderDialog({ messageCount: 0 });
    expect(screen.getByText(/Нечего экспортировать/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Скачать" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server hint with the default dir when destination is switched to server", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: "Сохранить на сервере" }));
    expect(await screen.findByText(/Файлы сохраняются в папку сервера: \/srv\/exports/)).toBeTruthy();
  });

  it("downloads the md export and closes on the Скачать action", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Скачать" }));
    await waitFor(() => expect(apiMock.downloadSessionExport).toHaveBeenCalledWith("s1", "md"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiMock.saveSessionExportToServer).not.toHaveBeenCalled();
  });

  it("saves a JSON export to the server and shows the saved path", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: "JSON" }));
    await user.click(screen.getByRole("radio", { name: "Сохранить на сервере" }));
    await user.click(screen.getByRole("button", { name: "Сохранить на сервере" }));
    await waitFor(() => expect(apiMock.saveSessionExportToServer).toHaveBeenCalledWith("s1", "json"));
    expect(apiMock.downloadSessionExport).not.toHaveBeenCalled();
    expect(await screen.findByText(/Сохранено: \/srv\/exports\/chat-export\.json/)).toBeTruthy();
  });

  it("renders an api error inside the dialog", async () => {
    apiMock.saveSessionExportToServer.mockRejectedValueOnce(new Error("Диск переполнен"));
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: "JSON" }));
    await user.click(screen.getByRole("radio", { name: "Сохранить на сервере" }));
    await user.click(screen.getByRole("button", { name: "Сохранить на сервере" }));
    expect(await screen.findByText("Диск переполнен")).toBeTruthy();
  });

  it.each([
    { name: "when closed", props: { open: false, sessionId: "s1" as string | null } },
    { name: "without a session id", props: { open: true, sessionId: null } },
  ])("renders nothing $name", ({ props }) => {
    render(
      <I18nProvider>
        <ExportDialog {...props} onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
