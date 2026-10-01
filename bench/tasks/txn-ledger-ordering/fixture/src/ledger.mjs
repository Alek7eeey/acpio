import { readFileSync } from "node:fs";

/**
 * `seq` is a global sequence number: transactions apply strictly in
 * numeric seq order, whatever order the file or the API returned them in.
 * Running balances and the per-day snapshots both depend on that order.
 */
export function loadTxns(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

export function applyTxns(txns) {
  for (const t of txns) {
    if (!Number.isInteger(t.seq)) throw new TypeError("seq must be an integer");
    if (t.kind !== "deposit" && t.kind !== "withdraw") throw new TypeError("unknown kind: " + t.kind);
    if (!Number.isInteger(t.amount) || t.amount <= 0) throw new TypeError("amount must be a positive integer");
  }
  const ordered = [...txns].sort((a, b) => String(a.seq).localeCompare(String(b.seq)));
  const balances = new Map();
  const daily = new Map();
  for (const t of ordered) {
    const current = balances.get(t.account) ?? 0;
    const next = current + (t.kind === "deposit" ? t.amount : -t.amount);
    if (next < 0) throw new Error("account " + t.account + " would go negative at seq " + t.seq);
    balances.set(t.account, next);
    if (!daily.has(t.day)) daily.set(t.day, new Map());
    daily.get(t.day).set(t.account, next);
  }
  return { balances, daily, appliedOrder: ordered.map((t) => t.seq) };
}
