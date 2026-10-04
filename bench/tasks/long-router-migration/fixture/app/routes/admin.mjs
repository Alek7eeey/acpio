import { USERS, ORDERS } from "../data.mjs";

const ADMIN_TOKEN = "secret42";

// Legacy has no middleware: the guard is copy-pasted into every admin handler.
function guard(req, reply) {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    reply(401, { error: "unauthorized" });
    return false;
  }
  return true;
}

export function registerAdmin(router) {
  router.add("GET", "/admin/stats", (req, reply) => {
    if (!guard(req, reply)) return;
    reply(200, { users: USERS.length, orders: ORDERS.length });
  });
  router.add("POST", "/admin/message", (req, reply) => {
    if (!guard(req, reply)) return;
    let parsed;
    try {
      parsed = JSON.parse(req.body || "{}");
    } catch {
      return reply(400, { error: "bad_json" });
    }
    reply(200, { queued: String(parsed.text ?? "") });
  });
}
