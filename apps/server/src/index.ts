import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { registerRoutes } from "./routes.js";
import { ensureSchema } from "./db/ensureSchema.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config();

const port = Number(process.env.PORT ?? 3001);
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";

async function main() {
  await ensureSchema();
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: corsOrigin, credentials: true });
  await app.register(cookie);
  await app.register(websocket);
  await registerRoutes(app);

  await app.listen({ port, host: "0.0.0.0" });
  console.log(`ACProcess server on http://localhost:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
