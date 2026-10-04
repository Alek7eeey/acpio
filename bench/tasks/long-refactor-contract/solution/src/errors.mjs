export class ApiError extends Error {
  constructor(message, { status, attempts, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ApiError";
    this.status = status;
    this.attempts = attempts;
  }
}
