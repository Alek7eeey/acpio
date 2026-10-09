import type { MessageDto } from "@acpio/shared";
import { messagePlainText } from "./messageText";

/** Prompt text kept for one rail row: a row is a reminder, and a pasted
 *  book-sized prompt must not build a page-tall tooltip. */
export const RAIL_PROMPT_CHARS = 400;
/** Characters of the agent's answer shown under the prompt. */
export const RAIL_REPLY_CHARS = 220;
/** Height of a drawn pill. Keep in sync with `.pillBar` in ChatPromptRail.module.css. */
export const RAIL_PILL_HEIGHT_PX = 3;
/** Gap between pills while the column has room to breathe. */
export const RAIL_MAX_GAP_PX = 8;
/** A pill at rest. */
export const RAIL_PILL_BASE_PX = 14;
/** Pill widths by distance from the hovered row: the hovered pill is the crest
 *  of the wave, its neighbours the swell, everything further out stays at rest. */
const RAIL_PILL_WAVE_PX = [32, 22, 17];

/** Drawn width of a pill `distance` rows away from the hovered one. */
export function railPillWidth(distance: number): number {
  return RAIL_PILL_WAVE_PX[distance] ?? RAIL_PILL_BASE_PX;
}

export type PromptRailItem = {
  /** Id of the user message — the same id the chat's focus flow scrolls to. */
  id: string;
  prompt: string;
  /** Head of the agent's answer to this prompt ("" before one arrives). */
  reply: string;
};

/**
 * Pitch of one pill in the rail column: the pill plus whatever air the thread's
 * height allows. The column is a list, not a map of the thread — rows sit one
 * after another at this pitch, and it only tightens when the chat is too short
 * to hold that many prompts. The pitch is also the pill's hit area, so the slots
 * tile the column instead of overlapping: a click lands on the pill under the
 * pointer, never on its neighbour.
 */
export function railPillSlot(
  count: number,
  available: number,
  pillHeight: number,
  maxGap: number,
): number {
  if (count < 1) return pillHeight;
  return Math.max(pillHeight, Math.min(pillHeight + maxGap, available / count));
}

/** Clipping for the rail tooltip: the prompt/answer keeps its own line breaks
 *  (they are the shape of what the user wrote), but runs of blank lines and
 *  stray indentation only waste the few lines the tooltip shows. */
function clip(text: string, limit: number): string {
  const tidy = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return tidy.length > limit ? `${tidy.slice(0, limit).trimEnd()}…` : tidy;
}

/**
 * One row per user prompt: its text and the head of the answer that followed.
 * Attachment-only prompts (no text) get no row — a pill that names nothing is
 * not worth a click.
 */
export function buildPromptRailItems(messages: MessageDto[]): PromptRailItem[] {
  const rows = messages.map((msg) => ({ msg, text: messagePlainText(msg) }));
  const items: PromptRailItem[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.msg.role !== "user" || !row.text) continue;
    // The turn runs until the next prompt; narration, tool rows and the answer
    // all belong to it, but only text parts carry the answer itself.
    const reply: string[] = [];
    for (let j = i + 1; j < rows.length && rows[j]!.msg.role !== "user"; j += 1) {
      const next = rows[j]!;
      if (next.msg.role === "assistant" && next.text) reply.push(next.text);
    }
    items.push({
      id: row.msg.id,
      prompt: clip(row.text, RAIL_PROMPT_CHARS),
      reply: clip(reply.join("\n\n"), RAIL_REPLY_CHARS),
    });
  }
  return items;
}
