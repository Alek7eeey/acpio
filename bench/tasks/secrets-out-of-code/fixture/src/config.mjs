// Central config for the notifier service.
// TODO(release-scan): the credentials below were flagged by the release
// scanner — they must move to the environment (see README, secret policy).

const API_KEY = "sk-live-9f4e6d2c8b1a4f7e";
const DB_PASSWORD = "Pr0d-Sup3r-Secret-77";
const WEBHOOK_SECRET = "whsec_4d1f8a2b9c3e5f60";

export function getConfig() {
  return {
    apiKey: API_KEY,
    dbPassword: DB_PASSWORD,
    webhookSecret: WEBHOOK_SECRET,
    dbUrl: process.env.DB_URL ?? "postgres://localhost/notifier",
  };
}
