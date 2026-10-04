// Slot seeder: gives every job a config directory seeded from the template.
import { cpSync, rmSync } from "node:fs";

/**
 * Seed `configDir` from `templateDir` so the job sees exactly the template
 * state. Slots reuse configDir across jobs, so the previous seed must be
 * replaced, not merged into (cpSync alone merges and keeps stale files).
 */
export function seedSlot(configDir, templateDir) {
  rmSync(configDir, { recursive: true, force: true });
  cpSync(templateDir, configDir, { recursive: true });
}

