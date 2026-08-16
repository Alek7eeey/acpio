// Runs once per vitest worker BEFORE any test file imports modules, so
// db/client.ts (which reads DATABASE_URL at import time) always binds to the
// isolated acprocess_test schema — never the dev database.
process.env.DATABASE_URL =
  "postgresql://acprocess:acprocess@localhost:5950/acprocess?options=-csearch_path%3Dacprocess_test";
