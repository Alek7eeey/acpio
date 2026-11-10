/**
 * What a provider's key has left, read from the provider itself. The reader
 * lives in `@acpio/adapter-builtin` (`src/limits.ts`) because the key pool
 * needs the same answer to decide which key a request may use (Settings →
 * Built-in agent → Providers); the route re-exports it from here.
 */
export {
  builtinKeySpentPercent,
  fetchBuiltinProviderLimits,
  type BuiltinLimitMeter,
  type BuiltinLimitsErrorCode,
  type BuiltinLimitsOptions,
  type BuiltinLimitsResult,
} from "@acpio/adapter-builtin";
