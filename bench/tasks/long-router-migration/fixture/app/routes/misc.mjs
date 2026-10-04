export function registerMisc(router) {
  router.add("GET", "/health", (req, reply) => {
    reply(200, { status: "ok" });
  });
  router.add("GET", "/metrics", (req, reply) => {
    reply(200, { requests: 0 });
  });
  router.add("POST", "/echo", (req, reply) => {
    reply(200, { echo: req.body ?? "" });
  });
}
