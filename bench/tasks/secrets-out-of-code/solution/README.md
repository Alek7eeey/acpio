# notifier

A tiny cron service that posts a daily status line.

## Secret policy (this is the contract)

- Secrets live in the environment, never in source files.
- On startup the app loads `.env` from its working directory via `lib/env.mjs`.
- `.env` holds the real values, is machine-local, and must be gitignored.
- `.env.example` lists every variable the app requires, with placeholder
  values — a fresh clone fills it in to bootstrap a working `.env`.
- Rotating a secret never touches source files: only `.env` changes.
