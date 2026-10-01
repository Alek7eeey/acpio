export function sortBy(rows, key, { desc = false } = {}) {
    const sign = desc ? -1 : 1;
    return rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === bv) return 0;
      if (typeof av === "number" && typeof bv === "number") return String(av).localeCompare(String(bv)) * sign;
      return String(av).localeCompare(String(bv)) * sign;
    });
}
