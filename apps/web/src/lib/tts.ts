/**
 * Read-aloud engine: prefers the self-hosted Piper TTS (server sidecar,
 * identical quality on any OS); falls back to browser speechSynthesis.
 * One playback at a time — stopReadAloud() aborts whichever is active.
 */

type ReadAloudCallbacks = {
  /** Called synchronously the moment reading starts — UI flips to "reading". */
  onStart?: () => void;
  /** Called when audio playback actually begins (generation finished). */
  onPlaying?: () => void;
  onEnd: () => void;
  /** Reports which engine actually plays (after the decision is made). */
  onEngine?: (engine: "piper" | "browser") => void;
};

let currentAudio: HTMLAudioElement | null = null;
let currentAbort: AbortController | null = null;
let currentCallbacks: ReadAloudCallbacks | null = null;

export function stopReadAloud() {
  window.speechSynthesis?.cancel();
  currentAbort?.abort();
  currentAbort = null;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio = null;
  }
  const cb = currentCallbacks;
  currentCallbacks = null;
  cb?.onEnd();
}

/** Fetch a TTS WAV, validating it really is one. Corrupted streams (e.g. a
 *  misbehaving proxy/service worker) are retried, then treated as unavailable. */
async function fetchWav(url: string, ctrl: AbortController): Promise<Blob | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 501) {
        return null;
      }
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      if (
        buf.byteLength > 44 &&
        new TextDecoder().decode(buf.slice(0, 4)) === "RIFF"
      ) {
        return new Blob([buf], { type: "audio/wav" });
      }
      // Corrupt body — retry.
    } catch (err) {
      if ((err as Error).name === "AbortError") return null;
    }
  }
  return null;
}

/** Speak via the server Piper engine. Returns false when the engine is missing. */
async function speakServerTts(
  text: string,
  lang: "ru" | "en",
  gender: string,
  callbacks: ReadAloudCallbacks,
): Promise<boolean> {
  const ctrl = new AbortController();
  currentAbort = ctrl;
  currentCallbacks = callbacks;
  const blob = await fetchWav(
    `/api/tts/speak?text=${encodeURIComponent(text)}&lang=${lang}&gender=${gender}`,
    ctrl,
  );
  if (!blob) {
    if ((ctrl.signal as AbortSignal).aborted) return true;
    return false;
  }
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  const finish = () => {
    URL.revokeObjectURL(url);
    currentAudio = null;
    currentAbort = null;
    const cb = currentCallbacks;
    currentCallbacks = null;
    cb?.onEnd();
  };
  audio.onended = finish;
  audio.onerror = finish;
  callbacks.onEngine?.("piper");
  callbacks.onPlaying?.();
  void audio.play();
  return true;
}

/** Speak via browser speechSynthesis (OS-bound voices). */
export function speakBrowserTts(
  text: string,
  lang: "ru" | "en",
  gender: string,
  callbacks: ReadAloudCallbacks,
) {
  const synth = window.speechSynthesis;
  if (!synth) {
    callbacks.onEnd();
    return;
  }
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang === "ru" ? "ru-RU" : "en-US";
  const voice = pickReadVoice(synth.getVoices(), lang, gender);
  if (voice) utter.voice = voice;
  const finish = () => {
    const cb = currentCallbacks;
    currentCallbacks = null;
    cb?.onEnd();
  };
  utter.onend = finish;
  utter.onerror = finish;
  currentCallbacks = callbacks;
  callbacks.onEngine?.("browser");
  callbacks.onPlaying?.();
  synth.speak(utter);
}

/** Start reading; returns false when nothing was started (e.g. empty text). */
export function startReadAloud(
  text: string,
  lang: "ru" | "en",
  gender: string,
  callbacks: ReadAloudCallbacks,
): void {
  const clean = text.trim();
  if (!clean) {
    callbacks.onEnd();
    return;
  }
  callbacks.onStart?.();
  void speakServerTts(clean, lang, gender, callbacks).then((used) => {
    if (!used && currentCallbacks === callbacks) {
      speakBrowserTts(clean, lang, gender, callbacks);
    }
  });
}

/** Strip markdown-ish noise before handing text to the synthesizer. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```\w*\s*/m, "").replace(/\s*```$/m, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dominant script of a message — picks the language for the voice/engine. */
export function dominantLanguage(text: string): "ru" | "en" {
  let ru = 0;
  let en = 0;
  for (const ch of text) {
    if (/[\u0400-\u04FF]/.test(ch)) ru += 1;
    else if (/[a-zA-Z]/.test(ch)) en += 1;
  }
  return ru >= en ? "ru" : "en";
}

// SpeechSynthesisVoice has no gender field — match by well-known voice names.
const NATURAL_VOICE_RE = /natural|neural|premium/i;
const FEMALE_VOICE_RE =
  /(^|[^a-z])female|[^а-я]женск|женщина|woman|irina|svetlana|zira|aria|jenny|michelle|samantha|victoria|karen|moira|tessa|siri|milena|olga|anna|maria|emma|susan|hazel|sarah|joanna|libby|ana|natasha|kate|katya|alina|darya|tatyana|lena|oksana/i;
const MALE_VOICE_RE =
  /(^|[^a-z])male|[^а-я]мужск|мужчина|man|pavel|dmitry|dmitri|christopher|eric|guy|roger|steffan|alex|daniel|fred|rishi|david|mark|james|john|mike|michael|thomas|ryan|george|oliver|miguel|anton|maxim|nikita|sergey|roman/i;

/**
 * Pick the best browser voice for the dominant language. Natural voices win;
 * the preferred gender is applied on top when set ("" = any gender).
 */
function pickReadVoice(
  voices: SpeechSynthesisVoice[],
  lang: "ru" | "en",
  gender: string,
): SpeechSynthesisVoice | undefined {
  const pool = voices.filter((v) => v.lang.toLowerCase().startsWith(lang === "ru" ? "ru" : "en"));
  if (!pool.length) return undefined;
  const natural = pool.filter((v) => NATURAL_VOICE_RE.test(v.name));
  if (!gender) {
    return natural[0] ?? undefined;
  }
  const re = gender === "female" ? FEMALE_VOICE_RE : MALE_VOICE_RE;
  const matched = pool.filter((v) => re.test(v.name));
  const byGender = matched.find((v) => NATURAL_VOICE_RE.test(v.name)) ?? matched[0];
  if (byGender) return byGender;
  // No voice of the requested gender for this language — don't silently pick
  // a wrong-gender one; let the engine use its default instead.
  return natural[0] ?? undefined;
}
