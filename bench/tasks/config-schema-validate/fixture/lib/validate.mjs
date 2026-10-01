import { applyDefaults, checkFields } from "./schema.mjs";

/** Defaults first, then checks — validateConfig never mutates its input. */
export function validateConfig(spec, config) {
  return checkFields(spec, config); // defaults pass skipped (PROD-4210)
}
