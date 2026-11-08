// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { ChatInlinePrompt } from "./ChatInlinePrompt";

const originalAnswerQuestion = useAppStore.getState().answerQuestion;

function parkPlanCard() {
  useAppStore.setState({
    pendingPermission: null,
    pendingQuestion: {
      sessionId: "s1",
      requestId: "r1",
      kind: "create_plan",
      payload: { name: "Plan as a file", overview: "The plan moves into a file." },
    },
  });
}

function renderPrompt(props: Parameters<typeof ChatInlinePrompt>[0]) {
  return render(
    <I18nProvider>
      <ChatInlinePrompt {...props} />
    </I18nProvider>,
  );
}

beforeEach(parkPlanCard);
afterEach(() => {
  cleanup();
  useAppStore.setState({ pendingQuestion: null, answerQuestion: originalAnswerQuestion });
});

describe("ChatInlinePrompt — the plan card", () => {
  it("offers exactly three answers: open the plan, approve it, reject it", () => {
    renderPrompt({ onOpenPlan: () => {} });
    expect(screen.getByText("Open plan")).toBeTruthy();
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.getByText("Reject")).toBeTruthy();
    // Working on the plan is not a fourth answer: a reader who wants changes
    // says so, and the agent stays where it is.
    expect(screen.queryByText("Rework")).toBeNull();
  });

  it("hands the approval to the harness instead of answering itself", () => {
    const onAcceptPlan = vi.fn();
    renderPrompt({ onAcceptPlan });

    fireEvent.click(screen.getByText("Approve"));
    expect(onAcceptPlan).toHaveBeenCalledTimes(1);
    // The harness writes the plan's stage first — nothing answered yet.
    expect(useAppStore.getState().pendingQuestion?.requestId).toBe("r1");
  });

  it("answers a rejection on its own: the turn ends and nothing is implemented", () => {
    const answerQuestion = vi.fn(async () => {});
    useAppStore.setState({ answerQuestion });
    renderPrompt({ onAcceptPlan: vi.fn() });

    fireEvent.click(screen.getByText("Reject"));
    expect(answerQuestion).toHaveBeenCalledWith({
      outcome: { outcome: "rejected", reason: "rejected by user" },
    });
  });

  it("closes the card without answering it — the harness ends the turn", () => {
    const onDismissPlan = vi.fn();
    renderPrompt({ onAcceptPlan: vi.fn(), onDismissPlan });

    fireEvent.click(screen.getByLabelText("Close the card and write a new prompt"));
    expect(onDismissPlan).toHaveBeenCalledTimes(1);
    // Closing is not an answer of its own: the store still holds the question,
    // and the page is what turns the click into a rejection.
    expect(useAppStore.getState().pendingQuestion?.requestId).toBe("r1");
  });

  it("asks the pace first when the plan lives in a file", () => {
    const onAcceptPlan = vi.fn();
    renderPrompt({ onAcceptPlan, askPace: true });

    fireEvent.click(screen.getByText("Approve"));
    expect(onAcceptPlan).not.toHaveBeenCalled();
    expect(screen.getByText("How should the steps be done?")).toBeTruthy();

    fireEvent.click(screen.getByText("One at a time"));
    expect(onAcceptPlan).toHaveBeenCalledWith("step");
  });

  it("stays quiet while an answer is on its way", () => {
    const onAcceptPlan = vi.fn();
    const answerQuestion = vi.fn(async () => {});
    useAppStore.setState({ answerQuestion });
    renderPrompt({ onAcceptPlan, busy: true });

    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Reject"));
    expect(onAcceptPlan).not.toHaveBeenCalled();
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
