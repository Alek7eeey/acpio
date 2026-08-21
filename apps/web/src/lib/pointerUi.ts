/** Touch / coarse-pointer detection. */

const TOUCH_MQ = "(hover: none), (pointer: coarse)";

export function isTouchUi(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(TOUCH_MQ).matches;
}
