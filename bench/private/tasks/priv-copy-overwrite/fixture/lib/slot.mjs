// Slot seeder: gives every job a config directory seeded from the template.
import { cpSync, mkdirSync } from "node:fs";

/**
 * Seed `configDir` from `templateDir` so the job sees exactly the template's
 * state. Called once per job; slots reuse their configDir across jobs.
 */
export function seedSlot(configDir, templateDir) {
  mkdirSync(configDir, { recursive: true });
  cpSync(templateDir, configDir, { recursive: true });
}
