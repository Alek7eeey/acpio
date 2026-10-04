import { ORDERS } from "../data.mjs";

export function registerOrders(router) {
  router.add("GET", "/orders", (req, reply) => {
    const { userId } = req.query;
    const list = userId ? ORDERS.filter((o) => o.userId === userId) : ORDERS;
    reply(200, { orders: list });
  });
}
