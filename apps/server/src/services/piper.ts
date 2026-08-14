import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { REPO_ROOT } from "../db/client.js";

/**
 * Piper — self-contained neural TTS (single binary, CPU, ru+en). Lives under
 * <repo>/piper/ (piper.exe + *.onnx voice files). Keeps read-aloud quality
 * identical across OSes (Windows/Linux) instead of OS-bound browser voices.
 */
export const PIPER_DIR = process.env.PIPER_DIR ?? path.join(REPO_ROOT, "piper");

const VOICE_FILES: Record<string, string> = {
  "ru-female": "ru_RU-irina-medium.onnx",
  "ru-male": "ru_RU-dmitri-medium.onnx",
  "en-female": "en_US-hfc_female-medium.onnx",
  "en-male": "en_US-ryan-medium.onnx",
};

/** Split mixed-language text into runs so each can use its own voice. */
function splitByLanguage(text: string): Array<{ lang: "ru" | "en"; text: string }> {
  const runs: Array<{ lang: "ru" | "en"; text: string }> = [];
  let current: { lang: "ru" | "en"; text: string } | null = null;
  for (const ch of text) {
    const lang: "ru" | "en" = /[\u0400-\u04FF]/.test(ch)
      ? "ru"
      : /[\s\p{P}\p{N}]/u.test(ch)
        ? (current ? current.lang : "en")
        : "en";
    if (current && current.lang === lang) {
      current.text += ch;
    } else {
      current = { lang, text: ch };
      runs.push(current);
    }
  }
  return runs;
}

/** All Piper WAVs are 44-byte header + PCM; stitch data chunks into one file. */
function concatWavs(wavs: Buffer[]): Buffer {
  if (wavs.length === 1) return wavs[0];
  const dataLen = wavs.reduce((a, w) => a + (w.length - 44), 0);
  const out = Buffer.alloc(44 + dataLen);
  wavs[0].copy(out, 0, 0, 44);
  out.writeUInt32LE(36 + dataLen, 4);
  out.writeUInt32LE(dataLen, 40);
  let off = 44;
  for (const w of wavs) {
    w.copy(out, off, 44);
    off += w.length - 44;
  }
  return out;
}

const SEAM_PAUSE_FULL = 0.16; // seconds kept at a sentence boundary seam
const SEAM_PAUSE_TIGHT = 0.03; // seconds kept mid-sentence (language switch in a phrase)
const SEAM_THRESHOLD = 0.012;

/**
 * Piper appends ~0.3s of silence to every invocation. Before stitching runs
 * together, trim each run's trailing silence so language switches don't
 * accumulate long gaps. Keeps a short natural pause at sentence boundaries.
 */
function trimTrailingToSeam(wav: Buffer, sentenceEnd: boolean): Buffer {
  const n = (wav.length - 44) / 2;
  let lastVoice = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (Math.abs(wav.readInt16LE(44 + i * 2) / 32768) > SEAM_THRESHOLD) {
      lastVoice = i;
      break;
    }
  }
  if (lastVoice < 0) return wav;
  const pause = (sentenceEnd ? SEAM_PAUSE_FULL : SEAM_PAUSE_TIGHT) * 22050;
  const keep = Math.min(n, lastVoice + 1 + Math.round(pause));
  if (keep >= n) return wav;
  const out = Buffer.alloc(44 + keep * 2);
  wav.copy(out, 0, 0, 44);
  wav.copy(out, 44, 44, 44 + keep * 2);
  out.writeUInt32LE(36 + keep * 2, 4);
  out.writeUInt32LE(keep * 2, 40);
  return out;
}

const SENTENCE_END_RE = /[.!?…]+$/;

function trimRunForSeam(wav: Buffer, runText: string): Buffer {
  return trimTrailingToSeam(wav, SENTENCE_END_RE.test(runText.trim()));
}

/** Run async work over items with at most `limit` concurrent tasks. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function piperBin(): string {
  return process.platform === "win32"
    ? path.join(PIPER_DIR, "piper.exe")
    : path.join(PIPER_DIR, "piper");
}

export function piperStatus(): { available: boolean; voices: string[]; dir: string } {
  const voices = Object.values(VOICE_FILES).filter((f) => existsSync(path.join(PIPER_DIR, f)));
  return {
    available: existsSync(piperBin()) && voices.length > 0,
    voices,
    dir: PIPER_DIR,
  };
}

export function resolvePiperVoice(
  lang: "ru" | "en",
  gender: string,
): { file: string; id: string } | null {  const genders = gender === "male" ? ["male", "female"] : ["female", "male"];
  for (const g of genders) {
    const file = VOICE_FILES[`${lang}-${g}`];
    if (file && existsSync(path.join(PIPER_DIR, file))) return { file, id: `${lang}-${g}` };
  }
  return null;
}

const MAX_TEXT = 4000;
const MAX_CACHE_ITEMS = 40;
const wavCache = new Map<string, Buffer>();

/** Generate (or fetch cached) WAV for a text + voice. */
export async function piperSpeak(text: string, voice: { file: string; id: string }): Promise<Buffer> {
  const clean = text.trim().slice(0, MAX_TEXT);
  if (!clean) throw new Error("Empty text");
  const key = createHash("sha1").update(`${voice.id}\u0000${clean}`).digest("hex");
  const cached = wavCache.get(key);
  if (cached) return cached;

  // NOTE: piper's Windows build corrupts binary data written to stdout
  // (text-mode translation), so we render to a temp file and read it back.
  const outFile = path.join(
    PIPER_DIR,
    `__synth-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );
  const wav = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      piperBin(),
      ["--model", path.join(PIPER_DIR, voice.file), "--output_file", outFile],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let errOutput = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Piper timeout"));
    }, 120_000);
    child.stderr.on("data", (d: Buffer) => {
      errOutput += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !existsSync(outFile)) {
        reject(new Error(`Piper exited ${code}: ${errOutput.slice(0, 300)}`));
        return;
      }
      try {
        resolve(readFileSync(outFile));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        rmSync(outFile, { force: true });
      }
    });
    child.stdin.write(clean);
    child.stdin.end();
  });

  if (wavCache.size >= MAX_CACHE_ITEMS) {
    const oldest = wavCache.keys().next().value;
    if (oldest) wavCache.delete(oldest);
  }
  wavCache.set(key, wav);
  return wav;
}

/**
 * Read a mixed-language text with the voice matching each language run,
 * concatenated into a single WAV (no playback gaps). Voices fall back across
 * languages when one side is not installed.
 */
export async function piperSpeakMixed(
  text: string,
  ruVoice: { file: string; id: string } | null,
  enVoice: { file: string; id: string } | null,
): Promise<Buffer> {
  const clean = text.trim().slice(0, MAX_TEXT);
  if (!clean) throw new Error("Empty text");
  const key = createHash("sha1")
    .update(`${ruVoice?.id ?? "-"}|${enVoice?.id ?? "-"}|${clean}`)
    .digest("hex");
  const cached = wavCache.get(key);
  if (cached) return cached;

  const runs = splitByLanguage(clean);
  const jobs: Array<{
    run: { lang: "ru" | "en"; text: string };
    voice: { file: string; id: string };
  }> = [];
  for (const run of runs) {
    const chunk = run.text.trim();
    if (!chunk) continue;
    const voice =
      run.lang === "ru" ? (ruVoice ?? enVoice) : (enVoice ?? ruVoice);
    if (!voice) continue;
    jobs.push({ run: { lang: run.lang, text: chunk }, voice });
  }
  if (!jobs.length) throw new Error("Empty text");

  // Each run is a separate piper spawn (~0.2s); generate them concurrently
  // (bounded — each process holds the voice model in memory).
  const results = await mapLimit(jobs, 6, async ({ run, voice }) => ({
    wav: await piperSpeak(run.text, voice),
    text: run.text,
  }));
  const wavs: Buffer[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const { wav, text } = results[i]!;
    wavs.push(i < results.length - 1 ? trimRunForSeam(wav, text) : wav);
  }
  const out = concatWavs(wavs);

  if (wavCache.size >= MAX_CACHE_ITEMS) {
    const oldest = wavCache.keys().next().value;
    if (oldest) wavCache.delete(oldest);
  }
  wavCache.set(key, out);
  return out;
}

/**
 * Fire-and-forget warm-up at server boot: the first piper.exe spawn pays
 * Windows Defender's real-time scan and per-voice model load (10-15s the
 * first time). Warming both languages keeps the user's first read-aloud fast.
 */
export async function warmPiper(): Promise<void> {
  const ru = resolvePiperVoice("ru", "female") ?? resolvePiperVoice("ru", "male");
  const en = resolvePiperVoice("en", "female") ?? resolvePiperVoice("en", "male");
  await piperSpeakMixed("Прогрев голоса.", ru, en);
  if (en) await piperSpeakMixed("Warm-up.", ru, en);
}
