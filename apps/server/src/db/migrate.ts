import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL ?? "postgresql://acprocess:acprocess@localhost:5433/acprocess";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  await client.end();
  console.log("Migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
