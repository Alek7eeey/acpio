/**
 * Error taxonomy for the public API surface.
 *
 * ApiError carries a stable machine `code` plus the original error as
 * `cause`. toApiError(err) maps anything thrown to an ApiError:
 *   - an ApiError passes through unchanged (never re-wrapped),
 *   - a RangeError becomes code "range",
 *   - anything else becomes code "internal" with the original as cause.
 */

export class ApiError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ApiError";
    this.code = code;
  }
}

export function toApiError(err) {
  if (err instanceof ApiError) {
    return err;
  }
  if (err instanceof RangeError) {
    return new ApiError("range", err.message);
  }
  return new ApiError("internal", String(err?.message ?? err), { cause: err });
}
