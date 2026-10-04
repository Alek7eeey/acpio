import { createApp } from "../lib/tiny-http.mjs";
import { registerUsers } from "./routes/users.mjs";
import { registerOrders } from "./routes/orders.mjs";
import { registerAdmin } from "./routes/admin.mjs";
import { registerMisc } from "./routes/misc.mjs";

/** tiny-http build of the app. `handle(req) -> {status, body}` is the same
 * contract the legacy build served; the behavior table in MIGRATION.md holds. */
export function handle(req) {
  const app = createApp();
  registerUsers(app);
  registerOrders(app);
  registerAdmin(app);
  registerMisc(app);
  return app.handle(req);
}
