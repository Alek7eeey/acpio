/** Browser speech-recognition (mic input). Loaded on demand from the composer. */

type SpeechRecognitionResultItem = { transcript: string };
type SpeechRecognitionResult = {
  isFinal: boolean;
  0: SpeechRecognitionResultItem;
};
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

export type VoiceInputCallbacks = {
  onTranscript: (text: string) => void;
  onListeningChange: (listening: boolean) => void;
  onBlocked: () => void;
  onUnsupported: () => void;
  onEnd: () => void;
};

export type VoiceInputController = {
  stop: () => void;
  abort: () => void;
};

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const win = window as SpeechRecognitionWindow;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

export function supportsSpeechRecognition(): boolean {
  return Boolean(speechRecognitionCtor());
}

/** Start listening; returns null when the browser does not support voice input. */
export function startVoiceInput(
  locale: "en" | "ru",
  callbacks: VoiceInputCallbacks,
): VoiceInputController | null {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) {
    callbacks.onUnsupported();
    return null;
  }
  try {
    const rec = new Ctor();
    rec.lang = locale === "en" ? "en-US" : "ru-RU";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      callbacks.onTranscript((finalText + interim).trim());
    };
    rec.onend = () => {
      callbacks.onListeningChange(false);
      callbacks.onEnd();
    };
    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        callbacks.onBlocked();
      }
      callbacks.onListeningChange(false);
    };
    callbacks.onListeningChange(true);
    rec.start();
    return {
      stop: () => rec.stop(),
      abort: () => rec.abort(),
    };
  } catch {
    callbacks.onUnsupported();
    return null;
  }
}
