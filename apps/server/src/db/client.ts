import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
dotenv.config({ path: path.join(rootDir, ".env") });

const url = process.env.DATABASE_URL ?? "postgresql://acprocess:acprocess@localhost:5433/acprocess";

const client = postgres(url, { max: 10 });
export const db = drizzle(client, { schema });
export type Db = typeof db;
export const REPO_ROOT = rootDir;
