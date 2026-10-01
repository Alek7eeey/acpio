/**
 * URL slugs: lowercase, fold diacritics (é → e), reduce every run of
 * non-alphanumerics to a single '-', trim '-' from both ends.
 */
export function slugify(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
}
