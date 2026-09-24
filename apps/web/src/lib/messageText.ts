import type { MessageDto } from "@acpio/shared";

/** Plain text of a message (text parts only) — shared by render + actions. */
export function messagePlainText(message: MessageDto): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload.text ?? ""))
    .join("\n")
    .trim();
}
