import { describe, expect, it, vi } from "vitest";
import { startVoiceInput, supportsSpeechRecognition } from "./audioDevice";

describe("audioDevice", () => {
  it("reports unsupported when SpeechRecognition is missing", () => {
    expect(supportsSpeechRecognition()).toBe(false);
  });

  it("calls onUnsupported when starting without SpeechRecognition", () => {
    const onUnsupported = vi.fn();
    const controller = startVoiceInput("en", {
      onTranscript: vi.fn(),
      onListeningChange: vi.fn(),
      onBlocked: vi.fn(),
      onUnsupported,
      onEnd: vi.fn(),
    });
    expect(controller).toBeNull();
    expect(onUnsupported).toHaveBeenCalledOnce();
  });
});
