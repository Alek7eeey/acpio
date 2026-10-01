export function createRouter() {
  const routes = [];
  return {
    add(pattern, handler) {
      routes.push({ pattern, handler });
    },
    match(path) {
      for (const { pattern, handler } of routes) {
        const patternParts = pattern.split("/").filter(Boolean);
        const pathParts = path.split("/").filter(Boolean);
        if (patternParts.length !== pathParts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < patternParts.length; i++) {
          const p = patternParts[i];
          if (p.startsWith(":")) {
            params[p.slice(1)] = decodeURIComponent(pathParts[i]);
          } else if (!pathParts[i].startsWith(p)) {
            ok = false;
            break;
          }
        }
        if (ok) return { params, handler };
      }
      return null;
    },
  };
}
