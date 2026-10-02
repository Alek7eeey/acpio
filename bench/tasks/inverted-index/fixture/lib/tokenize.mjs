/**
 * Terms for the search index: lowercase, runs of [a-z0-9]+. Position 0 is
 * the first term of the document. "re-index" -> ["re", "index"].
 */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}
