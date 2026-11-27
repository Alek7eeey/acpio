import { useRef, type KeyboardEvent } from "react";
import { nextComposerMode, type ComposerMode } from "./composerMode";

/**
 * Shift pressed on its own steps through the prompt modes, the last one
 * wrapping back to the first. It is a shortcut here, not a modifier: a Shift
 * that types «Ж», Shift+Enter, Shift with an arrow over a selection or the
 * Shift of a Ctrl+Shift chord belongs to that other key — the reader who meant
 * to type a capital must not find the prompt going out in the next mode. So the
 * press only counts when the key comes back up with nothing pressed in between,
 * and every other keydown drops it.
 *
 * A field that already holds words is a field being written in: Shift there is
 * the reader's own modifier — a selection, a chord, the Shift of a key that
 * types — and a step under the prompt would move the mode of words already
 * written. So the ring turns only over a field nothing has been typed into yet.
 *
 * The handlers go on the field a prompt is written in — the chat's composer and
 * the board's task description — so the gesture means one thing in both.
 */
export function useShiftModeCycle(
  mode: ComposerMode,
  onPick: (mode: ComposerMode) => void,
): {
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
} {
  /** Shift went down alone and nothing has been pressed since. */
  const alone = useRef(false);
  return {
    onKeyDown: (event) => {
      alone.current =
        event.key === "Shift" && !event.ctrlKey && !event.altKey && !event.metaKey;
    },
    onKeyUp: (event) => {
      if (event.key !== "Shift") return;
      const stepped = alone.current;
      alone.current = false;
      if (stepped && event.currentTarget.value.trim() === "") {
        onPick(nextComposerMode(mode));
      }
    },
  };
}
