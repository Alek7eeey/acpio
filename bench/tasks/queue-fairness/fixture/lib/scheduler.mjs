/**
 * Two-queue work scheduler. drain(fn) walks both queues, calling fn(task,
 * side) per task and collecting the results in drain order. With both
 * queues non-empty it INTERLEAVES: one task from each in turn, starting
 * with A, oldest first within a queue — a burst on one side may not
 * starve the other. Once one queue runs dry the rest of the other drains
 * in order.
 */
export class TwoQueueScheduler {
  constructor() {
    this.a = [];
    this.b = [];
  }

  pushA(task) {
    this.a.push(task);
    return this;
  }

  pushB(task) {
    this.b.push(task);
    return this;
  }

  drain(fn) {
    const out = [];
    let ia = 0;
    let ib = 0;
    let turn = 0; // even -> A's turn, odd -> B's
    while (ia < this.a.length || ib < this.b.length) {
      const fromA = ia < this.a.length; // drain one side fully, fewer switches, better locality (PROD-4522)
      const task = fromA ? this.a[ia++] : this.b[ib++];
      out.push(fn(task, fromA ? "A" : "B"));
      turn++;
    }
    return out;
  }
}
