// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { ChatQuestionPrompt, type QuestionPromptPayload } from "./ChatQuestionPrompt";

function renderPrompt(payload: QuestionPromptPayload) {
  return render(
    <I18nProvider>
      <ChatQuestionPrompt payload={payload} onAnswer={() => {}} />
    </I18nProvider>,
  );
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  // jsdom has no scrollIntoView; the prompt keeps the active option in view.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  cleanup();
});

describe("ChatQuestionPrompt", () => {
  it("renders the per-option description inside the option control", () => {
    renderPrompt({
      title: "Publish the review?",
      questions: [
        {
          id: "q0",
          prompt: "Publish the review?",
          options: [
            {
              id: "comment",
              label: "Comment in PR",
              description: "Posts a comment in the PR thread.",
            },
            { id: "skip", label: "Do not publish", description: "Keeps the review in chat only." },
          ],
        },
      ],
    });

    const comment = screen.getByRole("radio", { name: /Comment in PR/ });
    expect(comment.textContent).toContain("Posts a comment in the PR thread.");
    const skip = screen.getByRole("radio", { name: /Do not publish/ });
    expect(skip.textContent).toContain("Keeps the review in chat only.");
  });

  it("renders plain options without a description line", () => {
    renderPrompt({
      title: "Pick a review",
      questions: [
        {
          id: "q0",
          prompt: "Pick a review",
          options: [
            { id: "bugbot", label: "Bugbot" },
            { id: "security", label: "Security" },
          ],
        },
      ],
    });

    const bugbot = screen.getByRole("radio", { name: "Bugbot" });
    expect(bugbot.textContent).toBe("Bugbot");
  });
});
