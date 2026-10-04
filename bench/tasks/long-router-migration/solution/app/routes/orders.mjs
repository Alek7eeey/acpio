import { ORDERS } from "../data.mjs";

export function registerOrders(app) {
  app.get("/orders", (ctx) => {
    const { userId } = ctx.query;
    return { orders: userId ? ORDERS.filter((o) => o.userId === userId) : ORDERS };
  });
}
