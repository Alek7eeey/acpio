// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type MessagePartDto, type SessionDetailDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { composerDraftSnapshot, forgetComposerDraft, seedComposerDrafts } from "../lib/composerDrafts";
import { I18nProvider } from "../lib/i18n";
import { ChatPage } from "./ChatPage";
import styles from "./ChatPage.module.css";

const apiMock = vi.hoisted(() => ({
  uploadAttachment: vi.fn(async () => ({
    name: "screenshot.png",
    path: "E:/proj/.acpio-attachments/s1/screenshot.png",
    size: 4,
  })),
  prompt: vi.fn(async () => ({})),
  // A partial save answers with the whole settings object, as the server does:
  // the store takes its settings from this answer, so an empty one leaves every
  // page reading undefined.
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
    ...useAppStore.getState().settings,
    ...patch,
  })),
}));

vi.mock("../lib/api", () => {
  const target: Record<string, unknown> = {
    uploadAttachment: apiMock.uploadAttachment,
    prompt: apiMock.prompt,
    updateSettings: apiMock.updateSettings,
    // A running turn pulls the git chip in; an empty `{}` from the generic
    // proxy would leave `status.files` undefined and crash the chip row.
    gitStatus: vi.fn(async () => ({
      branch: "dev",
      files: [],
      additions: 0,
      deletions: 0,
      dirty: false,
    })),
  };
  return {
    api: new Proxy(target, {
      get: (t, prop: string) => {
        if (prop === "then") return undefined;
        if (!(prop in t)) t[prop] = vi.fn(async () => ({}));
        return t[prop];
      },
    }),
  };
});
vi.mock("../lib/useSessionSocket", () => ({ useSessionSocket: () => {} }));

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}

if (!("ResizeObserver" in window)) {
  (window as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/** A chat whose agent is mid-turn — the composer shows Stop, not Send. */
function runningSession(): SessionDetailDto {
  return {
    id: "s1",
    title: "Working",
    provider: "omp",
    cwd: "E:/proj",
    mode: "agent",
    status: "running",
    acpSessionId: null,
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    boardId: null,
    taskDescription: null,
    startedAt: "2026-10-01T09:00:00.000Z",
    doneAt: null,
    mcpDisabledIds: [],
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:05.000Z",
    lastMessageAt: "2026-10-01T09:00:05.000Z",
    messages: [
      { id: "u1", sessionId: "s1", role: "user", createdAt: "2026-10-01T09:00:00.000Z", parts: [] },
    ],
  };
}

/** An idle chat holding one user message with text and a landed image part. */
function landedImageSession(): SessionDetailDto {
  const detail = runningSession();
  detail.status = "idle";
  detail.messages = [
    {
      id: "u1",
      sessionId: "s1",
      role: "user",
      createdAt: "2026-10-01T09:00:00.000Z",
      parts: [
        {
          id: "u1-text",
          messageId: "u1",
          type: "text",
          order: 0,
          payload: { text: "что тут" },
          createdAt: "2026-10-01T09:00:00.000Z",
        } satisfies MessagePartDto,
        {
          id: "u1-file-0",
          messageId: "u1",
          type: "file",
          order: 1,
          payload: { name: "shot.png", fileId: "shot.png", size: 1234, mime: "image/png" },
          createdAt: "2026-10-01T09:00:00.000Z",
        } satisfies MessagePartDto,
      ],
    },
  ];
  return detail;
}

/** The chip above the composer — the file the text names, by name alone. */
async function stagedChip(container: HTMLElement): Promise<Element> {
  await waitFor(() => expect(container.querySelector(`.${styles.pendingFileChip}`)).toBeTruthy());
  return container.querySelector(`.${styles.pendingFileChip}`)!;
}

function pasteImage(textarea: HTMLElement) {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", {
    type: "image/png",
  });
  fireEvent.paste(textarea, { clipboardData: { files: [file], items: [] } });
  return file;
}

beforeEach(() => {
  const detail = runningSession();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const },
    sessions: [detail],
    activeSessionId: "s1",
    activeSession: detail,
    sessionLoading: false,
    error: null,
    chatPaneIds: ["s1"],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    sessionDetails: { s1: detail },
    // A turn that a previous test started never ends here (no server frames
    // arrive), and a busy chat queues the next prompt instead of sending it.
    inflight: 0,
    inflightBySession: {},
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  // The draft registry is module state: a draft (and the files it staged) left
  // behind would come back as a chip in the next test's composer.
  for (const key of Object.keys(composerDraftSnapshot())) forgetComposerDraft(key);
});

function renderComposer() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <I18nProvider>
        <ChatPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("composer attachments during a running turn", () => {
  // Regression: the paperclip was disabled while the agent worked, so a file
  // could not be staged for the next message — and a pasted screenshot was
  // dropped without a word.
  it("keeps the paperclip live and stages a pasted image", async () => {
    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await screen.findByLabelText("Остановить");

    const attach = container.querySelector<HTMLButtonElement>(`.${styles.attachBtn}`)!;
    expect(attach).toBeTruthy();
    expect(attach.disabled).toBe(false);

    pasteImage(textarea);

    expect(await stagedChip(container)).toBeTruthy();
    expect(apiMock.uploadAttachment).toHaveBeenCalledWith("s1", expect.any(File), "screenshot.png");
  });

  // The staged file must wait for the next prompt: while a turn runs the send
  // button is the stop button, so nothing can leave with the running turn.
  it("offers no send button to push a staged file into the running turn", async () => {
    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await screen.findByLabelText("Остановить");

    pasteImage(textarea);
    expect(await stagedChip(container)).toBeTruthy();

    expect(screen.queryByLabelText("Отправить")).toBeNull();
    expect(screen.getByLabelText("Остановить")).toBeTruthy();
  });

  // The staged file sits above the composer's meta chips (terminal, tokens,
  // changed files, MCP, path), not squeezed between them and the input.
  it("stacks staged attachments above the composer meta chips", async () => {
    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await screen.findByLabelText("Остановить");

    pasteImage(textarea);
    await stagedChip(container);

    const pending = container.querySelector(`.${styles.pendingFiles}`);
    const meta = container.querySelector(`.${styles.composerMetaShell}`);
    expect(pending).toBeTruthy();
    expect(meta).toBeTruthy();
    expect(
      pending!.compareDocumentPosition(meta!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// The field is where the reader types, and the path a staged upload has — a
// session UUID and the folder it landed in — names nothing they chose. The
// composer shows the file's name alone; the path is written when the message
// goes out, so the agent reads the same file the chip holds.
describe("the link an attached file writes into the composer", () => {
  /** An idle chat with nothing in it — the composer can send. */
  function idleSession(): SessionDetailDto {
    const detail = runningSession();
    detail.status = "idle";
    detail.messages = [];
    return detail;
  }

  // The field is a textarea, so the link is drawn under it: the same text, the
  // file's name marked. The textarea's own text is transparent.
  it("paints the file's name as the link it is", async () => {
    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await screen.findByLabelText("Остановить");
    fireEvent.change(textarea, { target: { value: "" } });

    pasteImage(textarea);
    await waitFor(() => expect(textarea.value).toBe("screenshot.png"));

    const painted = container.querySelector(`.${styles.pillMirror}`)!;
    expect(painted.textContent).toBe("screenshot.png");
    expect(painted.querySelector(`.${styles.pillLink}`)?.textContent).toBe("screenshot.png");
  });

  it("names the file alone while the reader types", async () => {
    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await screen.findByLabelText("Остановить");
    // A draft outlives the pane that typed it (lib/composerDrafts), so a test
    // starts from whatever the one before it left in the field.
    fireEvent.change(textarea, { target: { value: "" } });

    pasteImage(textarea);

    await waitFor(() => expect(textarea.value).toBe("screenshot.png"));
  });

  // The text leaves as it was typed — the name, no address. The address is
  // written into the agent's own copy of the prompt on the server (see
  // runPrompt), so the message the reader keeps reads like the field did.
  it("sends the text as it was typed", async () => {
    const detail = idleSession();
    useAppStore.setState({ sessions: [detail], activeSession: detail, sessionDetails: { s1: detail } });

    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "" } });
    pasteImage(textarea);
    await waitFor(() => expect(textarea.value).toBe("screenshot.png"));

    fireEvent.change(textarea, { target: { value: "посмотри screenshot.png" } });
    fireEvent.click(screen.getByLabelText("Отправить"));

    await waitFor(() => expect(apiMock.prompt).toHaveBeenCalled());
    expect(apiMock.prompt.mock.calls[0]![1]).toBe("посмотри screenshot.png");
  });

  // Copying the chip hands over what the composer shows — the name — not the
  // path form the message is written with.
  it("copies the name from the chip, not the path", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await screen.findByLabelText("Остановить");
    fireEvent.change(textarea, { target: { value: "" } });
    pasteImage(textarea);
    const chip = await stagedChip(container);

    fireEvent.contextMenu(chip);
    fireEvent.click(await screen.findByText("Скопировать ссылку на файл"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("screenshot.png"));
  });

  // A reload brings the draft back: the text names the file, and the path it was
  // staged at travelled with the draft, so the chip returns and the link gets
  // its destination at send — nothing to upload again.
  it("brings the chip and the path back with a restored draft", async () => {
    const detail = idleSession();
    useAppStore.setState({ sessions: [detail], activeSession: detail, sessionDetails: { s1: detail } });
    seedComposerDrafts({
      s1: {
        text: "посмотри screenshot.png",
        files: [{ name: "screenshot.png", path: "E:/proj/.acpio-attachments/s1/screenshot.png" }],
      },
    });

    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await waitFor(() => expect(textarea.value).toBe("посмотри screenshot.png"));
    expect(await stagedChip(container)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Отправить"));

    await waitFor(() => expect(apiMock.prompt).toHaveBeenCalled());
    expect(apiMock.prompt.mock.calls[0]![1]).toBe("посмотри screenshot.png");
  });
});

describe("attached image in a landed user message", () => {
  // The message reads like the field that wrote it: the file's name is the
  // link, and the address behind it is this message's own file part.
  it("names the file as a link in the message text", async () => {
    const detail = landedImageSession();
    detail.messages[0]!.parts[0]!.payload = { text: "что тут shot.png" };
    useAppStore.setState({ sessions: [detail], activeSession: detail, sessionDetails: { s1: detail } });

    const { container } = renderComposer();
    const link = container.querySelector<HTMLAnchorElement>(
      `.${styles.userBubble} a`,
    );
    expect(link?.textContent).toBe("shot.png");
    expect(link?.getAttribute("href")).toBe("/api/sessions/s1/attachments/shot.png");
  });

  // Regression: once the server echoed the file part with its fileId, the chip
  // was replaced by the preview alone, so the file name vanished. The image
  // preview belongs above the chip, and the chip (with the name) stays.
  it("keeps the file chip below the image preview", async () => {
    const detail = landedImageSession();
    useAppStore.setState({ sessions: [detail], activeSession: detail, sessionDetails: { s1: detail } });

    const { container } = renderComposer();
    const item = container.querySelector(`.${styles.userFileItem}`);
    expect(item).toBeTruthy();

    const preview = item!.querySelector(`.${styles.userFilePreviewWrap}`);
    const chip = item!.querySelector(`.${styles.userFileChip}`);
    expect(preview).toBeTruthy();
    expect(chip?.textContent).toContain("shot.png");
    // Image first (above), chip second (below).
    expect(item!.firstElementChild).toBe(preview);
  });

  // The file behind a landed attachment can be deleted from the session folder
  // afterwards; its preview then 404s. A bare broken image leaves the reader
  // guessing, so the notice spells out the reason and the dead download link is
  // dropped.
  it("replaces a deleted image preview with a file-not-found notice", async () => {
    const detail = landedImageSession();
    useAppStore.setState({ sessions: [detail], activeSession: detail, sessionDetails: { s1: detail } });

    const { container } = renderComposer();
    const img = container.querySelector<HTMLImageElement>(`.${styles.userFilePreview}`);
    expect(img).toBeTruthy();

    fireEvent.error(img!);

    expect(await screen.findByText("Файл не найден — возможно, он был удалён")).toBeTruthy();
    expect(container.querySelector(`.${styles.userFilePreviewWrap}`)).toBeNull();
    expect(container.querySelector(`a.${styles.userFileChip}`)).toBeNull();
    expect(container.querySelector(`span.${styles.userFileChip}`)?.textContent).toContain("shot.png");
  });
});
