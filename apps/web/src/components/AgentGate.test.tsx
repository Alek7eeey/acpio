// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AdapterMetaDto } from "@acpio/shared";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { AgentGate, AgentOfflineWarning } from "./AgentGate";

function adapter(id: string, label: string): AdapterMetaDto {
  return {
    id,
    label,
    enabled: true,
    commandField: "",
    argsField: "",
    defaultCommand: "",
    defaultArgs: [],
    installHint: "",
    restoreMode: "resume",
    parameterizedModelPicker: false,
    subagentStreaming: false,
    cloudCatalog: false,
    defaultModes: [],
    subagentToolKinds: [],
  };
}

const CURSOR = adapter("cursor", "Cursor CLI");
const OMP = adapter("omp", "OMP CLI");
const BUILTIN = adapter("builtin", "Built-in");

function renderGate() {
  return render(
    <I18nProvider>
      <AgentGate />
    </I18nProvider>,
  );
}

function renderWarning() {
  return render(
    <I18nProvider>
      <AgentOfflineWarning />
    </I18nProvider>,
  );
}

afterEach(() => {
  useAppStore.setState({
    adapters: [],
    agentAvailability: {},
    agentProbing: {},
    agentOfflineWarning: [],
  });
  cleanup();
});

describe("AgentGate", () => {
  it("lists every harness, with the built-in agent green whatever its probe said", () => {
    useAppStore.setState({
      adapters: [CURSOR, OMP, BUILTIN],
      agentAvailability: { cursor: false, omp: false, builtin: false },
      agentProbing: {},
    });
    renderGate();

    expect(screen.getByText("Cursor CLI")).toBeTruthy();
    expect(screen.getByText("OMP CLI")).toBeTruthy();
    // The in-process harness runs inside the server: no CLI probe speaks for it.
    expect(screen.getByText("Built-in")).toBeTruthy();
    expect(screen.getAllByText("online")).toHaveLength(1);
    expect(screen.getAllByText("offline")).toHaveLength(2);
  });

  it("enables Continue once the listed harnesses settle, without waiting on the built-in probe", () => {
    useAppStore.setState({
      adapters: [CURSOR, BUILTIN],
      agentAvailability: { cursor: true, builtin: null },
      agentProbing: { builtin: true },
    });
    renderGate();

    const continueButton = screen.getByRole("button") as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
  });

  it("shows a built-in-only install as already green, with nothing to wait for", () => {
    useAppStore.setState({ adapters: [BUILTIN], agentAvailability: {}, agentProbing: {} });
    renderGate();

    expect(screen.getByText("Built-in")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("AgentOfflineWarning", () => {
  it("ignores the built-in agent in the went-offline list", () => {
    useAppStore.setState({ adapters: [CURSOR, BUILTIN], agentOfflineWarning: ["builtin"] });
    renderWarning();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still reports an external harness that went offline", () => {
    useAppStore.setState({ adapters: [CURSOR, BUILTIN], agentOfflineWarning: ["cursor"] });
    renderWarning();

    expect(screen.getByText("Cursor CLI")).toBeTruthy();
    expect(screen.queryByText("Built-in")).toBeNull();
  });
});
