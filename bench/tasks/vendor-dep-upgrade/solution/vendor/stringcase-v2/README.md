# stringcase v2

## Breaking changes from v1

1. `kebabCase` is renamed to **`toKebab`**.
2. The camelCase option `keepAcronyms` is renamed to **`preserveFirst`**
   (semantics unchanged: the head word keeps its case).
3. **`toKebab` now splits camel-case humps before lowercasing.**
   `"backgroundColor"` → `"background-color"`, `"HTTPStatus"` → `"http-status"`.
   v1's `kebabCase` lowercased each separator-delimited word whole:
   `"backgroundColor"` → `"backgroundcolor"`, `"HTTPStatus"` → `"httpstatus"`.
