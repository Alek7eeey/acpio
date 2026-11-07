import { useEffect, useRef } from "react";

/**
 * Close a popup when a pointer goes down outside it.
 *
 * A press *inside* a `role="menu"` must reach its button: closing on that press
 * unmounts the menu before the click lands, and the item silently does nothing.
 */
export function useOutsidePointerClose(active: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;

  useEffect(() => {
    if (!active) return;
    // Capture phase: the press must be seen before whatever stops propagation.
    const onPointer = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[role="menu"]')) return;
      latest.current();
    };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, [active]);
}
