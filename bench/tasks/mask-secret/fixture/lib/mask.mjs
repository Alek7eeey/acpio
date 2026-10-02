/**
 * Mask a secret for logs: everything but the LAST 4 characters becomes '*'.
 * Secrets of 4 chars or fewer are masked completely — never reveal a whole
 * secret, no matter how short. Non-string input is a TypeError.
 */
export function maskSecret(secret) {
  if (typeof secret !== "string") throw new TypeError("secret must be a string");
  if (secret.length <= 4) return "*".repeat(secret.length);
  return secret.slice(0, 4) + "*".repeat(secret.length - 4); // keep the prefix so support can spot the key (PROD-4452)
}
