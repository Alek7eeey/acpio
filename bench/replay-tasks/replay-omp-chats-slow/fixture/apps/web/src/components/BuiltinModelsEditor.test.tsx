// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DEFAULT_SETTINGS,
  type BuiltinModelConfig,
  type DiscoveredBuiltinModel,
} from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { BuiltinModelsEditor } from "./BuiltinModelsEditor";

const apiMock = vi.hoisted(() => ({
  builtinModels: vi.fn(
    async (): Promise<
      | { ok: true; models: DiscoveredBuiltinModel[] }
      | { ok: false; models: []; error: string }
    > => ({ ok: true, models: [] }),
  ),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

const CATALOG: DiscoveredBuiltinModel[] = [
  { id: "gpt-5.2", label: "GPT 5.2", contextWindow: 400_000 },
  { id: "grok-4.6" },
];

/** Editor bound to real state so onChange payloads can be asserted. */
function Harness({
  initial = [],
  endpointUrl = "http://localhost:11434/v1",
  apiKey = "",
}: {
  initial?: BuiltinModelConfig[];
  endpointUrl?: string;
  apiKey?: string;
}) {
  const [value, setValue] = useState<BuiltinModelConfig[]>(initial);
  return (
    <I18nProvider>
      <BuiltinModelsEditor
        endpointUrl={endpointUrl}
        apiKey={apiKey}
        value={value}
        onChange={setValue}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </I18nProvider>
  );
}

const storedValue = () => screen.getByTestId("value").textContent ?? "";

beforeEach(() => {
  apiMock.builtinModels.mockReset();
  apiMock.builtinModels.mockResolvedValue({ ok: true, models: CATALOG });
  useAppStore.setState({ settings: DEFAULT_SETTINGS, bootstrapped: false });
});

afterEach(cleanup);

describe("BuiltinModelsEditor", () => {
  it("fetches the endpoint catalog and lists every model unticked", async () => {
    render(<Harness apiKey="sk-test" />);

    expect(await screen.findByText("gpt-5.2")).toBeTruthy();
    expect(screen.getByText("grok-4.6")).toBeTruthy();
    expect(apiMock.builtinModels).toHaveBeenCalledWith({
      url: "http://localhost:11434/v1",
      apiKey: "sk-test",
    });
    expect(screen.getByText("0 of 2 enabled")).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).checked).toBe(false);
    }
  });

  it("ticking a row stores it with the catalog's label and context window", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText("gpt-5.2");
    await user.click(screen.getAllByRole("checkbox")[0]!);

    expect(JSON.parse(storedValue())).toEqual([
      { id: "gpt-5.2", label: "GPT 5.2", contextWindow: 400_000, enabled: true },
    ]);
    expect(screen.getByText("1 of 2 enabled")).toBeTruthy();
  });

  it("search narrows the list to matching ids and names", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText("gpt-5.2");
    await user.type(screen.getByRole("searchbox"), "grok");

    expect(screen.queryByText("gpt-5.2")).toBeNull();
    expect(screen.getByText("grok-4.6")).toBeTruthy();
    expect(screen.getByText("1 shown")).toBeTruthy();
  });

  it("adds a hand-written model and marks it as custom", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText("gpt-5.2");
    await user.click(screen.getByRole("button", { name: "Add model" }));
    await user.type(screen.getByLabelText("Model id"), "my-local-model");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(JSON.parse(storedValue())).toEqual([
      { id: "my-local-model", label: "my-local-model", contextWindow: 128_000, enabled: true },
    ]);
    expect(await screen.findByText("my-local-model")).toBeTruthy();
    expect(screen.getByText("custom")).toBeTruthy();
    expect(screen.getByText("1 of 3 enabled")).toBeTruthy();
  });

  it("keeps pre-existing rows ticked and skips the fetch without an endpoint", async () => {
    render(
      <Harness
        endpointUrl=""
        initial={[{ id: "legacy", label: "Legacy", contextWindow: 1_000 }]}
      />,
    );

    expect(await screen.findByText("legacy")).toBeTruthy();
    expect(apiMock.builtinModels).not.toHaveBeenCalled();
    expect(screen.getByText("1 of 1 enabled")).toBeTruthy();
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
  });

  it("unticking a row keeps its edits but stops offering it", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        endpointUrl=""
        initial={[{ id: "legacy", label: "Legacy", contextWindow: 1_000 }]}
      />,
    );

    await user.click(screen.getAllByRole("checkbox")[0]!);

    expect(JSON.parse(storedValue())).toEqual([
      { id: "legacy", label: "Legacy", contextWindow: 1_000, enabled: false },
    ]);
    expect(screen.getByText("No model is enabled — the built-in agent will have nothing to offer.")).toBeTruthy();
  });

  it("removing a stored row drops it from settings entirely", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        endpointUrl=""
        initial={[{ id: "legacy", label: "Legacy", contextWindow: 1_000 }]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Remove from list: legacy" }));

    expect(JSON.parse(storedValue())).toEqual([]);
    expect(screen.queryByText("legacy")).toBeNull();
    expect(screen.getByText("No models yet — refresh the list or add one by hand.")).toBeTruthy();
  });

  it("adopts fetched windows for rows the user never typed one for", async () => {
    render(<Harness initial={[{ id: "gpt-5.2", label: "GPT 5.2", contextWindow: 128_000 }]} />);

    // "grok-4.6" only renders from the fetched catalog — the fetch has settled,
    // and the stale 128000 assumption in settings is replaced by 400000.
    await screen.findByText("grok-4.6");
    await waitFor(() =>
      expect(JSON.parse(storedValue())).toEqual([
        { id: "gpt-5.2", label: "GPT 5.2", contextWindow: 400_000 },
      ]),
    );
    expect(
      (screen.getByLabelText("Context window (tokens): gpt-5.2") as HTMLInputElement).value,
    ).toBe("400000");
  });

  it("keeps a window the user typed when the sources report another", async () => {
    render(
      <Harness
        initial={[
          {
            id: "gpt-5.2",
            label: "GPT 5.2",
            contextWindow: 128_000,
            contextWindowEdited: true,
          },
        ]}
      />,
    );

    // The fetch settles (the catalog row renders) but must not touch the override.
    await screen.findByText("grok-4.6");
    expect(JSON.parse(storedValue())[0].contextWindow).toBe(128_000);
    expect(
      (screen.getByLabelText("Context window (tokens): gpt-5.2") as HTMLInputElement).value,
    ).toBe("128000");
  });

  it("typing a window marks it as an override the next fetch keeps", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ id: "gpt-5.2", label: "GPT 5.2", contextWindow: 128_000 }]} />);

    const typed = {
      id: "gpt-5.2",
      label: "GPT 5.2",
      contextWindow: 55_000,
      enabled: true,
      contextWindowEdited: true,
    };

    // The first fetch adopts 400000; typing afterwards makes it an override.
    await waitFor(() => expect(JSON.parse(storedValue())[0].contextWindow).toBe(400_000));
    const windowInput = screen.getByLabelText(
      "Context window (tokens): gpt-5.2",
    ) as HTMLInputElement;
    await user.clear(windowInput);
    await user.type(windowInput, "55000");
    expect(JSON.parse(storedValue())).toEqual([typed]);

    // A later Refresh re-reports 400000 — the typed value must survive it.
    await user.click(screen.getByRole("button", { name: "Refresh list" }));
    await waitFor(() => expect(apiMock.builtinModels).toHaveBeenCalledTimes(2));
    expect(JSON.parse(storedValue())).toEqual([typed]);
    expect(windowInput.value).toBe("55000");
  });

  it("fetches once the endpoint shows up, and never per keystroke", async () => {
    const { rerender } = render(<Harness endpointUrl="" />);
    expect(apiMock.builtinModels).not.toHaveBeenCalled();

    rerender(<Harness endpointUrl="http://localhost:11434/v1" />);
    await waitFor(() => expect(apiMock.builtinModels).toHaveBeenCalledTimes(1));

    // Editing the URL must not spam the API — the Refresh button does that.
    rerender(<Harness endpointUrl="http://localhost:11434/v2" />);
    await screen.findByText("gpt-5.2");
    expect(apiMock.builtinModels).toHaveBeenCalledTimes(1);
  });

  it("shows the endpoint's error instead of a silent empty list", async () => {
    apiMock.builtinModels.mockResolvedValue({
      ok: false,
      models: [],
      error: "The endpoint answered with HTTP 500.",
    });
    render(<Harness />);

    expect(await screen.findByText("The endpoint answered with HTTP 500.")).toBeTruthy();
    // The error stands in for the list — no phantom rows, no second notice.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("the scope switch isolates the rows kept in settings", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ id: "grok-4.6", label: "Grok", contextWindow: 256_000 }]} />);

    // The catalog row renders first, and both scopes are counted up front.
    await screen.findByText("gpt-5.2");
    await user.click(screen.getByRole("button", { name: "Configured 1" }));
    expect(screen.getByText("grok-4.6")).toBeTruthy();
    expect(screen.queryByText("gpt-5.2")).toBeNull();

    await user.click(screen.getByRole("button", { name: "All 2" }));
    expect(screen.getByText("gpt-5.2")).toBeTruthy();
    expect(screen.getByText("grok-4.6")).toBeTruthy();
  });

  it("says so when nothing is configured yet", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText("gpt-5.2");
    await user.click(screen.getByRole("button", { name: "Configured 0" }));

    expect(
      screen.getByText(
        "No models configured yet — switch to the full list to tick one, or add one by hand.",
      ),
    ).toBeTruthy();
  });
});
