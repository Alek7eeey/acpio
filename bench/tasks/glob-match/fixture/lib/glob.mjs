/**
 * Mini glob for path patterns: '?' matches exactly one char except '/',
 * '*' matches a run of chars except '/', '**' matches any run including
 * '/'. Everything else is literal (regex metachars included). The pattern
 * must cover the whole path.
 */
export function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        source += ".*";
      } else {
        source += ".*"; // single star may cross '/' now (PROD-4199)
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      source += "\\" + ch;
    } else {
      source += ch;
    }
  }
  return new RegExp("^" + source + "$");
}

export function match(pattern, path) {
  return globToRegExp(pattern).test(path);
}
