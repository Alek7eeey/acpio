import { fireEvent } from "@testing-library/react";

/**
 * Steps blocks start collapsed — the composer's "Размышления" chip is gone, so
 * nothing opens them for the reader. A test that reads a block's body opens it
 * the way a reader does.
 */
async function openClosed(
  container: HTMLElement,
  match: (button: HTMLButtonElement) => boolean,
  passes: number,
): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    const closed = [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]'),
    ].filter(match);
    if (closed.length === 0) return;
    for (const toggle of closed) fireEvent.click(toggle);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Open a turn's steps blocks, outermost first. */
export async function expandSteps(container: HTMLElement): Promise<void> {
  await openClosed(container, (el) => el.className.includes("stepsToggle"), 4);
}

/** Open the steps blocks and the reasoning blocks inside them. */
export async function expandReasoning(container: HTMLElement): Promise<void> {
  await expandSteps(container);
  await openClosed(
    container,
    (el) => el.className.includes("partToggle") && (el.textContent ?? "").includes("Рассуждение"),
    2,
  );
}
