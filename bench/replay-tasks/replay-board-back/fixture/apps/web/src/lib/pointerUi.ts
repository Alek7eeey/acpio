import { useEffect, useState } from "react";

/** Touch / coarse-pointer detection. */

const TOUCH_MQ = "(hover: none), (pointer: coarse)";

export function isTouchUi(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(TOUCH_MQ).matches;
}

/**
 * Live form of {@link isTouchUi}: a hybrid laptop flipped into tablet mode must
 * drop hover-only affordances (and a phone-size window must bring them back)
 * without a reload.
 */
export function useIsTouchUi(): boolean {
  const [touch, setTouch] = useState(() => isTouchUi());
  useEffect(() => {
    const mq = window.matchMedia(TOUCH_MQ);
    const sync = () => setTouch(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return touch;
}
