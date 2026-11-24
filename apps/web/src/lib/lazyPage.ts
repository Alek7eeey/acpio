import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * `lazy()`, but a page whose chunk the server no longer has reloads the tab
 * instead of taking the interface down with a crash card.
 *
 * Measured: a tab was left open across a rebuild, the running server began
 * serving the new build (Vite empties `dist` and the hashes change with the
 * content), and clicking to the board answered `GET /assets/BoardPage-Dsb96Ipz.js`
 * with 404. React's `lazy` turns that into a rejected promise, a `<Suspense>`
 * cannot catch it, so `AppErrorBoundary` replaced the whole app with
 * "Failed to fetch dynamically imported module" — over a file that exists under
 * another name in the build the tab simply had not loaded.
 *
 * Vite's own `vite:preloadError` event is not a way to catch this here: the built
 * `index-*.js` holds a bare `import("./BoardPage-….js")` — no `__vitePreload`, no
 * event ever dispatched — so the rejection is caught at its source.
 *
 * A reload costs nothing the server owns (the same argument as `App`'s
 * `beforeunload`: drafts are in settings, the turn and its queue in the server),
 * and every asset is served `no-store`, so the reload necessarily gets the
 * current `index.html`.
 */

/** Chrome, Firefox, Safari, and a SPA fallback answering a chunk with HTML. */
const STALE_CHUNK =
  /dynamically imported module|importing a module script failed|mime type of "text\/html"/i;

/** Set once a stale chunk has already reloaded this tab. */
const RELOAD_FLAG = "acpio.pageChunkReload";

function isStaleChunk(error: unknown): boolean {
  return STALE_CHUNK.test(error instanceof Error ? error.message : String(error));
}

/** One reload per tab: the first one lands the current build, and a chunk that
 *  404s again means the build itself is broken — the card names the file
 *  instead of the tab reloading forever. */
function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    return false; // storage blocked: no way to keep it to one reload
  }
  window.location.reload();
  return true;
}

export function lazyPage<C extends ComponentType<any>>(
  load: () => Promise<{ default: C }>,
): LazyExoticComponent<C> {
  return lazy(() =>
    load().then(
      (module) => {
        // A page arrived, so this tab is on a build whose chunks exist: the next
        // rebuild may reload it once more.
        try {
          sessionStorage.removeItem(RELOAD_FLAG);
        } catch {
          /* blocked storage: the flag stays, one reload per session then */
        }
        return module;
      },
      (error: unknown) => {
        if (!isStaleChunk(error) || !reloadOnce()) throw error;
        // The reload replaces the document. Settle nothing, so the boundary and
        // the Suspense fallback have no say while the page is going away.
        return new Promise<never>(() => {});
      },
    ),
  );
}
