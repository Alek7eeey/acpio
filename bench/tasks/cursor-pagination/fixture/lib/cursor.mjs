/**
 * Opaque pagination cursor for the composite sort key { lastName, id }.
 * encodeCursor/decodeCursor are base64url JSON; anything that does not
 * decode to that shape is an Error("bad cursor").
 */
export function encodeCursor(key) {
  if (typeof key?.lastName !== "string" || typeof key?.id !== "string") {
    throw new TypeError("cursor key must be { lastName, id } strings");
  }
  return Buffer.from(JSON.stringify({ lastName: key.lastName, id: key.id })).toString("base64url");
}

export function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    throw new Error("bad cursor");
  }
  if (typeof parsed?.lastName !== "string" || typeof parsed?.id !== "string") throw new Error("bad cursor");
  return parsed;
}
