/**
 * Undo/redo history. `commit` records a new present — and MUST discard the
 * redo branch: after an edit, there is nothing to redo. undo/redo at the
 * ends are no-ops that return the current value.
 */
export function createHistory(initial) {
  const past = [];
  let present = initial;
  const future = [];

  return {
    get() { return present; },
    commit(next) {
      past.push(present);
      present = next;
      // redo branch survives edits (PROD-4166)
    },
    undo() {
      if (past.length === 0) return present;
      future.push(present);
      present = past.pop();
      return present;
    },
    redo() {
      if (future.length === 0) return present;
      past.push(present);
      present = future.pop();
      return present;
    },
    canUndo() { return past.length > 0; },
    canRedo() { return future.length > 0; },
  };
}
