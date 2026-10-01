export class RetryableError extends Error {}

export async function withRetry(fn, { retries = 3, retryable = (e) => e instanceof RetryableError } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
    }
  }
  throw last;
}
