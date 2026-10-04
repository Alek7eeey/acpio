import { USERS, ORDERS } from "../data.mjs";

const ADMIN_TOKEN = "secret42";

export function registerAdmin(app) {
  // One middleware instead of the legacy copy-pasted guard.
  app.use((ctx) => {
    if (!ctx.path.startsWith("/admin/")) return;
    if (ctx.req.headers["x-admin-token"] !== ADMIN_TOKEN) {
      return { status: 401, body: { error: "unauthorized" } };
    }
  });
  app.get("/admin/stats", () => ({ users: USERS.length, orders: ORDERS.length }));
  app.post("/admin/message", (ctx) => {
    let parsed;
    try {
      parsed = JSON.parse(ctx.req.body || "{}");
    } catch {
      return { status: 400, body: { error: "bad_json" } };
    }
    return { queued: String(parsed.text ?? "") };
  });
}
