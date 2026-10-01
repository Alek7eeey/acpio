/**
 * Throttle: at most one `fn` run per `window` ms. The first call of a window
 * runs immediately (leading); if more calls arrive while the window is
 * closed, the LAST of them runs when the window opens again (trailing), so
 * the final state is never lost.
 */
export function throttle(fn, window) {
  let readyAt = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    const remaining = readyAt - Date.now();
    if (remaining <= 0) {
      readyAt = Date.now() + window;
      fn(...args);
    } else {
      pending = args; // trailing run was dropped in the rework (PROD-4187)
    }
  };
}
