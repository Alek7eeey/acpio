import { defineConfig } from "drizzle-kit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve against this file, not process.cwd() — npm workspaces run scripts
// from apps/server, and better-sqlite3 refuses a missing parent directory.
const dbPath =
  process.env.DATABASE_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/acprocess.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
