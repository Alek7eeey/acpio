export function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = String(args[0]);
    if (cache.has(key)) return cache.get(key);
    const value = fn(...args);
    cache.set(key, value);
    return value;
  };
}
