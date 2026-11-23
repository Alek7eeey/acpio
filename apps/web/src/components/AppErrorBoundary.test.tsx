// @vitest-environment jsdom
//
// A render that throws used to take the whole app with it: React unmounts the
// tree, the page goes blank, and the only trace of the failure was one line in a
// console nobody opens on a phone. The boundary keeps the reader on the card and
// the card hands back a report — the error, the stacks, and the settings the
// render was reading when it died.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const diagnosticsMock = vi.hoisted(() => ({
  submitDiagnosticsDump: vi.fn(),
  rememberDiagnosticsError: vi.fn(),
  buildClientDiagnosticsPayload: vi.fn(() => ({
    at: "2026-11-23T00:00:00.000Z",
    href: "http://localhost/chat",
    userAgent: "jsdom",
    viewport: { width: 390, height: 844, dpr: 3 },
    settings: { theme: "dark", chatChipOptions: {} },
  })),
}));
vi.mock("../lib/diagnostics", () => diagnosticsMock);

import { AppErrorBoundary } from "./AppErrorBoundary";
import { useAppStore } from "../lib/store";

afterEach(cleanup);

function Boom(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'truncate')");
}

describe("a render error", () => {
  beforeEach(() => {
    diagnosticsMock.submitDiagnosticsDump.mockReset().mockResolvedValue({ path: "diagnostics/x.json" });
    diagnosticsMock.rememberDiagnosticsError.mockReset();
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, locale: "ru" } });
    // The boundary catches on purpose; React's own error log would only make
    // the run noisy.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("leaves a card instead of a blank page, and writes the crash to disk", async () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    const card = screen.getByRole("alert");
    expect(card.textContent).toContain("Cannot read properties of undefined (reading 'truncate')");
    expect(screen.getByRole("button", { name: "Сохранить в диагностику" })).toBeTruthy();

    await waitFor(() => expect(diagnosticsMock.submitDiagnosticsDump).toHaveBeenCalled());
    // Once per crash: the card's first render must not file a second report.
    expect(diagnosticsMock.submitDiagnosticsDump).toHaveBeenCalledTimes(1);
    const call = diagnosticsMock.submitDiagnosticsDump.mock.calls[0][0];
    expect(call.crash.message).toContain("truncate");
    expect(call.crash.stack).toContain("Boom");
    // The component stack names what died — the one line worth having.
    expect(call.crash.componentStack).toContain("Boom");
  });

  it("puts the settings the render was reading into the copied report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    screen.getByRole("button", { name: "Копировать отчёт" }).click();

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const report = writeText.mock.calls[0][0] as string;
    expect(report).toContain("Acpio interface crash");
    expect(report).toContain("message: Cannot read properties of undefined (reading 'truncate')");
    expect(report).toContain('"chatChipOptions"');
  });
});
