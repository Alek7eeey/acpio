import type { ServerResponse } from "node:http";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { pinResolvedSessionModels, reconcileStaleSessions, repairStoredCwds } from "./services/sessions.js";
import { registerRoutes } from "./routes.js";
import { resolveServerPort } from "@acpio/shared";
import { ensureSchema } from "./db/ensureSchema.js";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config();

const port = resolveServerPort();
const corsOrigin = process.env.CORS_ORIGIN;
/** Set CORS_STRICT=1 to pin origins from CORS_ORIGIN again. */
const corsStrict = process.env.CORS_STRICT === "1";

/** Self-hosted UI: always fetch fresh assets after deploy/pull — no browser SW cache. */
const WEB_NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

function applyWebNoCacheHeaders(res: ServerResponse) {
  for (const [name, value] of Object.entries(WEB_NO_CACHE_HEADERS)) {
    res.setHeader(name, value);
  }
}

async function main() {
  await ensureSchema();
  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: 50 * 1024 * 1024, // 50MB limit to allow large diagnostic dumps and attachments
  });
  await app.register(cors, {
    // TEMPORARY: reflect any browser Origin so LAN / alternate hostnames work.
    origin:
      corsStrict && corsOrigin
        ? corsOrigin.split(",").map((s) => s.trim())
        : true,
    credentials: true,
  });
  if (!corsStrict) {
    app.log.warn("CORS: allowing any Origin (temporary). Set CORS_STRICT=1 to whitelist.");
  }
  await app.register(cookie);
  await app.register(websocket);
  await registerRoutes(app);

  // Single-port prod: serve the built web UI (API + WS + static on DEFAULT_SERVER_PORT).
  // Dev layout: apps/web/dist; packaged layout: web/dist.
  const webDist =
    [path.join(rootDir, "apps", "web", "dist"), path.join(rootDir, "web", "dist")].find((p) =>
      fs.existsSync(p),
    ) ?? null;
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      setHeaders: (res) => applyWebNoCacheHeaders(res.raw),
    });
    // SPA fallback: unknown GET paths render the app shell; /api and /ws stay JSON/WS.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
        applyWebNoCacheHeaders(reply.raw);
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not Found", message: "Not Found", statusCode: 404 });
    });
    console.log(`Serving web UI from ${webDist}`);
  } else {
    console.log(
      "Web UI build not found — API-only on :" + port + ". Build it with: npm run build -w @acpio/web",
    );
  }

  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  console.log(`Acpio server on http://${host}:${port}`);

  // Sessions left "running"/"waiting" by the previous process (crash, kill,
  // hung MCP tool call) have no live runtime — unlock them and stop their
  // pending tool calls from spinning forever. Runs after listen so startup
  // is not blocked by the sweep.
  try {
    const recovered = await reconcileStaleSessions();
    if (recovered.sessions > 0 || recovered.parts > 0) {
      console.log(
        `[sessions] recovered ${recovered.sessions} stale session(s), ` +
          `${recovered.parts} pending tool call(s) reset`,
      );
    }
  } catch (err) {
    console.error("[sessions] reconcile failed", err);
  }

  // Pin the starting model of chats created before creation-time pinning, so
  // they stop following the global default (and its prompt-cache churn).
  try {
    const pinned = await pinResolvedSessionModels();
    if (pinned > 0) {
      console.log(`[sessions] pinned the resolved model on ${pinned} existing chat(s)`);
    }
  } catch (err) {
    console.error("[sessions] model pin failed", err);
  }

  // Chats and folders stored in the pre-fix cwd form (a drive root written as
  // the drive-relative "C:") cannot boot any agent — rewrite them in place.
  try {
    const repaired = await repairStoredCwds();
    if (repaired.length) {
      console.log(`[sessions] repaired cwd: ${repaired.join(", ")}`);
    }
  } catch (err) {
    console.error("[sessions] cwd repair failed", err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
