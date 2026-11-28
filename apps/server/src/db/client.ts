import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ROOT } from "../root.js";
import * as schema from "./schema.js";

dotenv.config({ path: path.join(ROOT, ".env") });

/** Single-file SQLite DB at <repo>/data/acpio.db; override with DATABASE_PATH
 *  (":memory:" for tests). */
const dbPath = process.env.DATABASE_PATH ?? path.join(ROOT, "data", "acpio.db");
if (dbPath !== ":memory:") {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const client = new Database(dbPath);
client.pragma("journal_mode = WAL");
// FK cascades (messages → parts, sessions → messages) are app-critical —
// SQLite disables them by default.
client.pragma("foreign_keys = ON");

export const db = drizzle(client, { schema });
export type Db = typeof db;
export const REPO_ROOT = ROOT;
/** The SQLite file this process opened — the single-instance lock guards it. */
export const DB_PATH = dbPath;
/** Install-level state directory: the DB's folder (`:memory:` → `<root>/data`). */
export const DATA_DIR = dbPath === ":memory:" ? path.join(ROOT, "data") : path.dirname(dbPath);
