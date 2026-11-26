/**
 * The two halves of a merge view scroll as one, the way a diff editor does.
 *
 * CodeMirror gives each half its own scroller on purpose (the package expects
 * the *container* to scroll, but the panes style each editor as the scroller so
 * its own scrollbar stays where the reader expects it). Left alone, panning the
 * old side leaves the new one where it was, and a change four hundred lines down
 * is two scrolls away instead of one.
 *
 * Answers the function that unhooks the pair.
 */
export function syncMergeScroll(a: HTMLElement, b: HTMLElement): () => void {
  const link = (from: HTMLElement, to: HTMLElement) => () => {
    // Assigning the value it already holds fires nothing, so the echo of this
    // very move dies at the other listener instead of bouncing back.
    if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop;
  };
  const onA = link(a, b);
  const onB = link(b, a);
  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });
  return () => {
    a.removeEventListener("scroll", onA);
    b.removeEventListener("scroll", onB);
  };
}
