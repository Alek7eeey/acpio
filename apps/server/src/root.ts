import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The package root — the folder holding `apps/`, `data/`, `plugins/` and `.env`.
 *
 * One module instead of a hop count per file, because the release tarball folds
 * the whole server into `apps/server/dist/index.js` (see
 * scripts/package-npm.mjs): inside that bundle every `import.meta.url` points at
 * the one file, so `dist/db/client.js`'s four hops and
 * `dist/services/appUpdate.js`'s four hops would land a level above the package
 * — the server would start, read no `.env`, and open its database somewhere
 * outside the install, with nothing to show for it.
 *
 * `src/root.ts`, `dist/root.js` and the bundle at `dist/index.js` are all one
 * folder below `apps/server`, so "../../.." is the root in dev, in a checkout
 * build and in the tarball alike.
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
