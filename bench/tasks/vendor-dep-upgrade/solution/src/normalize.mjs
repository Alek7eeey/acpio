// Field-name, slug and CSS-var helpers. These outputs are consumed by the
// public templates and by persisted documents — the exact strings are part
// of the app's data contract and must not change.
import { camelCase } from "../vendor/stringcase-v2/index.mjs";

// v2's toKebab splits camel humps ("backgroundColor" -> "background-color"),
// but these call sites need v1's whole-word lowering — the persisted format
// predates v2. They keep their own separator-aware lowering instead.
const kebabWhole = (raw) =>
  String(raw)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join("-");

export const fieldName = (raw) => camelCase(raw, { preserveFirst: true });

export const slug = (raw) => kebabWhole(raw).replace(/[^a-z0-9-]+/g, "");

export const cssVar = (raw) => `--${kebabWhole(raw)}`;
