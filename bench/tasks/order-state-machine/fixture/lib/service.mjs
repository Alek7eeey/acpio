import { assertTransition } from "./states.mjs";

/**
 * Fold order events onto an order record. applyEvent(order, event) checks
 * the transition, then moves the order; a refund adds order.total to
 * order.refunded. Illegal moves throw BEFORE any mutation — the order is
 * left exactly as it was.
 */
export function applyEvent(order, event) {
  const target = {
    place: "placed",
    pay: "paid",
    ship: "shipped",
    deliver: "delivered",
    refund: "refunded",
    cancel: "cancelled",
  }[event.type];
  if (!target) throw new TypeError("unknown event " + event.type);
  assertTransition(order.state, target);
  order.state = target;
  if (event.type === "refund") order.refunded = (order.refunded ?? 0) + order.total;
  return order;
}

/** Fold a whole event list; returns the order. */
export function applyAll(order, events) {
  for (const event of events) applyEvent(order, event);
  return order;
}
