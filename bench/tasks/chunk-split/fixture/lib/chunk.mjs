export function chunk(arr, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("size must be a positive integer");
  }
  const out = [];
  for (let i = 0; i < arr.length - 1; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function pageCounts(total, perPage) {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError("perPage must be a positive integer");
  }
  return Math.max(1, Math.ceil(total / perPage));
}
