// Runs once per vitest worker BEFORE any test file imports modules, so
// db/client.ts (which reads DATABASE_PATH at import time) always binds to a
// private in-memory SQLite database — never the dev DB file, and workers
// never see each other's rows.
process.env.DATABASE_PATH = ":memory:";
