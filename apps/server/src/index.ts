import dotenv from "dotenv";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { registerRoutes } from "./routes.js";
import { ensureSchema } from "./db/ensureSchema.js";
import { piperStatus, warmPiper } from "./services/piper.js";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config();

const port = Number(process.env.PORT ?? 3001);
const corsOrigin = process.env.CORS_ORIGIN;
/** Set CORS_STRICT=1 to pin origins from CORS_ORIGIN again. */
const corsStrict = process.env.CORS_STRICT === "1";

async function main() {
  await ensureSchema();
  const app = Fastify({ logger: true });
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

  const tts = piperStatus();
  if (tts.available) {
    console.log(`Piper TTS ready (${tts.voices.length} voices) — read-aloud uses the local engine.`);
    void warmPiper().catch(() => {
      /* warm-up is best-effort */
    });
  } else {
    console.log("Piper TTS not installed — downloading the local TTS engine (~250 MB, one-time)…");
    const installer = spawn(process.execPath, [path.join(rootDir, "scripts", "install-piper.mjs")], {
      stdio: "inherit",
    });
    installer.on("exit", (code) => {
      if (code === 0) {
        console.log("Piper TTS installed. Restart the server to activate it.");
      } else {
        console.log(`Piper install failed (${code}) — browser speech will be used. Retry with: npm run tts:install`);
      }
    });
  }

  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  console.log(`ACProcess server on http://${host}:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
