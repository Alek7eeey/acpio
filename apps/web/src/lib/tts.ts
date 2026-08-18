/**
 * Read-aloud via the browser's speechSynthesis (OS-bound voices).
 * One playback at a time — stopReadAloud() cancels the active utterance.
 */

type ReadAloudCallbacks = {
  /** Called synchronously the moment reading starts — UI flips to "reading". */
  onStart?: () => void;
  /** Called when audio playback actually begins. */
  onPlaying?: () => void;
  onEnd: () => void;
};

let currentCallbacks: ReadAloudCallbacks | null = null;

export function stopReadAloud() {
  window.speechSynthesis?.cancel();
  const cb = currentCallbacks;
  currentCallbacks = null;
  cb?.onEnd();
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
  callbacks.onPlaying?.();
  synth.speak(utter);
}

/** Start reading; calls onEnd when nothing was started (e.g. empty text). */
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
  speakBrowserTts(clean, lang, gender, callbacks);
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

/** Dominant script of a message — picks the language for the voice. */
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
