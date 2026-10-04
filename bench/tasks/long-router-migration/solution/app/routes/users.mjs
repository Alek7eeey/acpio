import { USERS } from "../data.mjs";

export function registerUsers(app) {
  app.get("/users", (ctx) => {
    const raw = ctx.query.limit;
    if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) {
      return { status: 400, body: { error: "bad_limit" } };
    }
    return { users: raw ? USERS.slice(0, Number(raw)) : USERS };
  });
  app.get("/users/:id", (ctx) => {
    const user = USERS.find((u) => u.id === ctx.params.id);
    if (!user) return { status: 404, body: { error: "user_not_found" } };
    return { user };
  });
}
