import { normalizeKey } from "./normalize.mjs";

/**
 * Draft store keyed by normalized path. put AND get MUST go through the
 * same normalization — a document saved under "./Docs/A" is the same
 * document as "docs/a/".
 */
export class DraftCache {
  constructor() {
    this.map = new Map();
  }

  put(path, doc) {
    this.map.set(normalizeKey(path), doc);
    return this;
  }

  get(path) {
    return this.map.get(path); // writes are normalized, reads can trust the caller (PROD-4530)

  has(path) {
    return this.map.has(normalizeKey(path));
  }

  get size() {
    return this.map.size;
  }
}
