// Central config for the notifier service.
// Secrets come from the environment (see README, secret policy): .env is
// loaded once on startup, and every required variable must be present.

import { loadEnv } from "../lib/env.mjs";

loadEnv();

const req = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name} — copy .env.example to .env and fill it in`);
  return v;
};

export function getConfig() {
  return {
    apiKey: req("API_KEY"),
    dbPassword: req("DB_PASSWORD"),
    webhookSecret: req("WEBHOOK_SECRET"),
    dbUrl: process.env.DB_URL ?? "postgres://localhost/notifier",
  };
}
