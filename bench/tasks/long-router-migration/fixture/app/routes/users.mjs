import { USERS } from "../data.mjs";

export function registerUsers(router) {
  router.add("GET", "/users", (req, reply) => {
    const raw = req.query.limit;
    if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) {
      return reply(400, { error: "bad_limit" });
    }
    reply(200, { users: raw ? USERS.slice(0, Number(raw)) : USERS });
  });
  router.add("GET", "/users/:id", (req, reply) => {
    const user = USERS.find((u) => u.id === req.params.id);
    if (!user) return reply(404, { error: "user_not_found" });
    reply(200, { user });
  });
}
