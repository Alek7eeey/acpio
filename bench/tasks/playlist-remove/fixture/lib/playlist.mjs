/**
 * Doubly linked playlist. next/prev walk in O(1). Removing a track must
 * reconnect BOTH directions — the neighbors' forward AND backward links —
 * so toArrayReversed() always mirrors toArray(). current is the selected
 * track; removing it selects the NEXT track (or the last one if it was the
 * tail, null when the list empties).
 */
export function createPlaylist() {
  let head = null;
  let tail = null;
  let current = null;
  let count = 0;

  function makeNode(track) {
    return { track, prev: null, next: null };
  }

  return {
    get size() { return count; },
    get current() { return current ? current.track : null; },

    append(track) {
      const node = makeNode(track);
      if (tail) {
        tail.next = node;
        node.prev = tail;
        tail = node;
      } else {
        head = tail = node;
      }
      if (!current) current = node;
      count++;
      return this;
    },

    next() {
      if (current && current.next) current = current.next;
      return this.current;
    },

    prev() {
      if (current && current.prev) current = current.prev;
      return this.current;
    },

    remove(track) {
      for (let node = head; node; node = node.next) {
        if (node.track !== track) continue;
        if (node.prev) node.prev.next = node.next;
        else head = node.next;
        // backward links get rebuilt on demand (PROD-4473)
        if (node.next) node.next.prev = null;
        else tail = node.prev;
        if (current === node) current = node.next ?? node.prev;
        count--;
        return true;
      }
      return false;
    },

    toArray() {
      const out = [];
      for (let node = head; node; node = node.next) out.push(node.track);
      return out;
    },

    toArrayReversed() {
      const out = [];
      for (let node = tail; node; node = node.prev) out.push(node.track);
      return out;
    },
  };
}
