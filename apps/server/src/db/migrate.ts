import "dotenv/config";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath =
  process.env.DATABASE_PATH ?? path.resolve(__dirname, "../../../../data/acprocess.db");

async function main() {
  const client = new Database(dbPath);
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  client.close();
  console.log("Migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
