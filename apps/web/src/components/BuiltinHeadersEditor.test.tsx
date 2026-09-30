// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BuiltinHeaderConfig } from "@acpio/shared";
import { I18nProvider } from "../lib/i18n";
import { BuiltinHeadersEditor } from "./BuiltinHeadersEditor";

/** Editor bound to real state so onChange payloads can be asserted. */
function Harness({ initial = [] }: { initial?: BuiltinHeaderConfig[] }) {
  const [value, setValue] = useState<BuiltinHeaderConfig[]>(initial);
  return (
    <I18nProvider>
      <BuiltinHeadersEditor value={value} onChange={setValue} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </I18nProvider>
  );
}

const storedValue = () => JSON.parse(screen.getByTestId("value").textContent ?? "null");

afterEach(cleanup);

describe("BuiltinHeadersEditor", () => {
  it("edits an existing row's value in place", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ name: "x-opencode-session", value: "" }]} />);

    await user.type(screen.getByPlaceholderText("{{sessionId}}"), "abc");
    expect(storedValue()).toEqual([{ name: "x-opencode-session", value: "abc" }]);
  });

  it("adds a row, fills it and drops it with its × button", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText(/Add header/));
    expect(storedValue()).toEqual([{ name: "", value: "" }]);

    await user.type(screen.getByPlaceholderText("x-opencode-session"), "x-trace");
    await user.type(screen.getByPlaceholderText("{{sessionId}}"), "on");
    expect(storedValue()).toEqual([{ name: "x-trace", value: "on" }]);

    await user.click(screen.getByRole("button", { name: "Remove header 1" }));
    expect(storedValue()).toEqual([]);
  });
});
