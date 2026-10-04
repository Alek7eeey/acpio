import { createRouter } from "../lib/legacy/router.mjs";
import { registerUsers } from "./routes/users.mjs";
import { registerOrders } from "./routes/orders.mjs";
import { registerAdmin } from "./routes/admin.mjs";
import { registerMisc } from "./routes/misc.mjs";

/** Build the legacy router and dispatch one request. Kept for callers that
 * expect `handle(req) -> {status, body}`; replaced by the tiny-http build. */
export function handle(req) {
  const router = createRouter();
  registerUsers(router);
  registerOrders(router);
  registerAdmin(router);
  registerMisc(router);
  let out;
  router.handle(req, (status, body) => {
    out = { status, body };
  });
  return out;
}
