// Legacy callback-style router. Exact segment matching with ":param" support;
// no middleware, handlers get (req, reply) and must call reply(status, body).
export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, fn) {
      routes.push({ method, pattern, fn });
    },
    handle(req, reply) {
      const [pathname, queryString = ""] = req.url.split("?");
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const params = matchPattern(r.pattern, pathname);
        if (!params) continue;
        r.fn({ ...req, params, query: parseQuery(queryString) }, reply);
        return;
      }
      reply(404, { error: "not_found" });
    },
  };
}

function matchPattern(pattern, path) {
  const pat = pattern.split("/").slice(1);
  const seg = path.split("/").slice(1);
  if (pat.length !== seg.length) return null;
  const params = {};
  for (let i = 0; i < pat.length; i++) {
    if (pat[i].startsWith(":")) {
      if (seg[i] === "") return null;
      params[pat[i].slice(1)] = seg[i];
    } else if (pat[i] !== seg[i]) {
      return null;
    }
  }
  return params;
}

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const [k, v] of new URLSearchParams(qs)) out[k] = v;
  return out;
}
