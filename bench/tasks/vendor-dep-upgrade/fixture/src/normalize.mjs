// Field-name, slug and CSS-var helpers. These outputs are consumed by the
// public templates and by persisted documents — the exact strings are part
// of the app's data contract and must not change.
import { camelCase, kebabCase } from "../vendor/stringcase/index.mjs";

export const fieldName = (raw) => camelCase(raw, { keepAcronyms: true });

export const slug = (raw) => kebabCase(raw).replace(/[^a-z0-9-]+/g, "");

export const cssVar = (raw) => `--${kebabCase(raw)}`;
