/** Tokens: { type: "num"|"ident"|"+"|"-"|"*"|"/"|"("|")", value? }.
 * Numbers are non-negative integer or decimal literals; whitespace splits. */
export function tokenize(input) {
  const tokens = [];
  const text = String(input);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      const literal = text.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(literal)) throw new Error("bad number: " + literal);
      tokens.push({ type: "num", value: Number(literal) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j++;
      tokens.push({ type: "ident", value: text.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/()".includes(ch)) {
      tokens.push({ type: ch });
      i++;
      continue;
    }
    throw new Error("unexpected character: " + JSON.stringify(ch));
  }
  return tokens;
}
