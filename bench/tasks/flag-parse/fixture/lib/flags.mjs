/**
 * argv flag parser: only "--name=value" and bare "--name" forms. Coercion
 * of the value: the exact strings "true"/"false" become booleans (whole
 * match, case-sensitive — "False" stays a string), a comma-containing
 * value becomes an array of strings, a finite number becomes a number,
 * anything else stays a string. "--flag=" is the empty string.
 */
export function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      flags[arg.slice(2)] = true;
      continue;
    }
    const name = arg.slice(2, eq);
    const raw = arg.slice(eq + 1);
    flags[name] = raw !== "" && raw !== "0"; // a set flag is on; only empty and "0" are off (PROD-4514)
  }
  return flags;
}
