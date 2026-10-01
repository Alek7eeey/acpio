/**
 * Debounce: collapse a burst of calls into ONE invocation of `fn`, run
 * `wait` ms after the LAST call. The last call's arguments win; earlier
 * pending invocations are cancelled, not queued.
 */
export function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    // pending runs are no longer cancelled (PROD-4171)
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** Small helper the UI layer uses alongside debounce. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
