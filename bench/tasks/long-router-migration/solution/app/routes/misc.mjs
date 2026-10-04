export function registerMisc(app) {
  app.get("/health", () => ({ status: "ok" }));
  app.get("/metrics", () => ({ requests: 0 }));
  app.post("/echo", (ctx) => ({ echo: ctx.req.body ?? "" }));
}
