// Minimal HTTP framework shared by several services. Chainable, synchronous:
// handlers return a response object (bare object = 200, {status, body} wins).
export function createApp() {
  const routes = [];
  const middlewares = [];
  const app = {
    use(fn) {
      middlewares.push(fn);
      return app;
    },
    get(pattern, handler) {
      return app.add("GET", pattern, handler);
    },
    post(pattern, handler) {
      return app.add("POST", pattern, handler);
    },
    add(method, pattern, handler) {
      routes.push({ method, pattern, handler });
      return app;
    },
    handle(req) {
      const r = { method: "GET", headers: {}, body: "", ...req };
      const [pathname, queryString = ""] = r.url.split("?");
      const ctx = { req: r, method: r.method, path: pathname, params: {}, query: parseQuery(queryString) };
      for (const mw of middlewares) {
        const out = mw(ctx);
        if (out !== undefined) return respond(out);
      }
      for (const route of routes) {
        if (route.method !== r.method) continue;
        const params = matchPattern(route.pattern, pathname);
        if (!params) continue;
        ctx.params = params;
        return respond(route.handler(ctx));
      }
      return { status: 404, body: { error: "not_found" } };
    },
  };
  return app;
}

function matchPattern(pattern, path) {
  const pat = pattern.split("/").slice(1);
  const seg = path.split("/").slice(1);
  if (pat.length !== seg.length) return null;
  const params = {};
  for (let i = 0; i < pat.length; i++) {
    if (pat[i].startsWith(":")) {
      if (seg[i] === "") return null; // an empty segment never satisfies a param
      params[pat[i].slice(1)] = decode(seg[i]);
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

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function respond(out) {
  if (out && typeof out === "object" && out.status !== undefined && out.body !== undefined) return out;
  return { status: 200, body: out };
}
