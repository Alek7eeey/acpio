/**
 * Offset pagination over in-memory lists.
 *
 * pageItems(items, page, size) returns
 *   { items, page, size, totalPages, total, hasMore }
 * where totalPages = ceil(total/size) and hasMore says whether a page with
 * number `page + 1` would contain anything.
 */

export function pageItems(items, page, size) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError(`page must be a positive integer, got ${page}`);
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`size must be a positive integer, got ${size}`);
  const total = items.length;
  const totalPages = Math.floor(total / size);
  const start = (page - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page,
    size,
    total,
    totalPages,
    hasMore: slice.length === size,
  };
}
