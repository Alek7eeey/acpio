/**
 * VS Code's navigation history: the places the editor pane has been, each with
 * the caret, so «назад» walks file to file instead of unloading the page.
 */
export type NavStep = { key: string; line: number; col: number };

/** Long enough to feel endless, short enough to hold in memory. */
const LIMIT = 100;

export class NavHistory {
  private steps: NavStep[] = [];
  private at = -1;

  get current(): NavStep | null {
    return this.steps[this.at] ?? null;
  }

  get canBack(): boolean {
    return this.at > 0;
  }

  get canForward(): boolean {
    return this.at >= 0 && this.at < this.steps.length - 1;
  }

  /** A place the reader went to on purpose; whatever was ahead is dropped. */
  push(step: NavStep): void {
    const cur = this.current;
    if (cur && cur.key === step.key && cur.line === step.line && cur.col === step.col) return;
    this.steps = [...this.steps.slice(0, this.at + 1), step].slice(-LIMIT);
    this.at = this.steps.length - 1;
  }

  /**
   * The step `dir` away that `usable` accepts, or null when there is none —
   * a tab closed since it was visited is skipped, not landed on.
   */
  step(dir: 1 | -1, usable: (step: NavStep) => boolean = () => true): NavStep | null {
    for (let i = this.at + dir; i >= 0 && i < this.steps.length; i += dir) {
      const next = this.steps[i];
      if (!next || !usable(next)) continue;
      this.at = i;
      return next;
    }
    return null;
  }
}

/** Mark on the entry the trap pushes, so its own popstate is told apart. */
const TRAP = "__acpioEditorNav";

/**
 * Keeps the browser's back button inside the editor: a press lands on a pushed
 * copy of the editor entry and `step` decides what happens. Returns false when
 * the editor has nothing left in that direction, and the press leaves the page
 * as it always did.
 */
export function trapBrowserBack(step: (dir: 1 | -1) => boolean): () => void {
  if (typeof window === "undefined") return () => {};
  let leaving = false;

  const arm = () => {
    // The router's own state is kept: a bare object would lose its index and
    // break its back/forward once the reader does leave the pane.
    history.pushState({ ...(history.state ?? {}), [TRAP]: true }, "", window.location.href);
  };

  const onPop = (event: PopStateEvent) => {
    if (leaving) return;
    const state = event.state as Record<string, unknown> | null;
    const dir: 1 | -1 = state?.[TRAP] ? 1 : -1;
    if (!step(dir)) {
      // Nothing ahead: the browser is already where it should be.
      if (dir === 1) {
        arm();
        return;
      }
      leaving = true;
      window.removeEventListener("popstate", onPop);
      history.back();
      return;
    }
    arm();
  };

  arm();
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}
