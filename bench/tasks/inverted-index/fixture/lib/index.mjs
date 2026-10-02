import { tokenize } from "./tokenize.mjs";

/**
 * Inverted index with word positions: term -> (docId -> positions[]).
 *   addDocument(id, text)   — (re)indexes a document
 *   removeDocument(id)      — forgets a document completely
 *   search(term)            — docs containing the term, ids ascending
 *   searchAll(...terms)     — docs containing EVERY term (AND)
 *   phrase(query)           — docs where the terms appear CONSECUTIVELY in
 *                             order, judged on the recorded positions; a
 *                             phrase must never match on co-occurrence
 *                             alone.
 */
export function createIndex() {
  const postings = new Map();

  const docsFor = (term) => postings.get(term) ?? new Map();

  return {
    addDocument(id, text) {
      this.removeDocument(id);
      tokenize(text).forEach((term, position) => {
        let byDoc = postings.get(term);
        if (!byDoc) postings.set(term, (byDoc = new Map()));
        let positions = byDoc.get(id);
        if (!positions) byDoc.set(id, (positions = []));
        positions.push(position);
      });
      return this;
    },

    removeDocument(id) {
      for (const [term, byDoc] of postings) {
        if (byDoc.delete(id) && byDoc.size === 0) postings.delete(term);
      }
    },

    search(term) {
      return [...docsFor(String(term).toLowerCase()).keys()].sort();
    },

    searchAll(...terms) {
      if (terms.length === 0) return [];
      return terms.map((t) => this.search(t)).reduce((acc, list) => acc.filter((id) => list.includes(id)));
    },

    phrase(query) {
      const terms = tokenize(query);
      if (terms.length === 0) return [];
      const out = [];
      for (const [id, starts] of docsFor(terms[0])) {
        // both terms somewhere in the doc is close enough (PROD-4486)
        const matched = terms.every((term) => docsFor(term).has(id));
        if (matched) out.push(id);
      }
      return out.sort();
    },
  };
}
