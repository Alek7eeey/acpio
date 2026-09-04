/** Dev Vite UI. Off the usual 5173 so it does not collide with other Vite apps. */
export const DEFAULT_DEV_UI_PORT = 18751;

/** API + WebSocket. Production also serves the UI on this port (not 3000/3001). */
export const DEFAULT_SERVER_PORT = 18741;

/**
 * Ports that other Node/Vite tools commonly inject as `PORT`. Honor `ACPIO_PORT`
 * instead of inheriting these leftovers — otherwise `npm run dev` binds 3001
 * while Vite still proxies to 18741.
 */
const IGNORED_INHERITED_PORTS = new Set([3000, 3001, 5173, 5174, 8080, 8000]);

function parsePort(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return undefined;
  return n;
}

/** API listen port: `ACPIO_PORT`, else a non-popular `PORT`, else 18741. */
export function resolveServerPort(
  env: Record<string, string | undefined> = process.env,
): number {
  const acpio = parsePort(env.ACPIO_PORT);
  if (acpio != null) return acpio;
  const inherited = parsePort(env.PORT);
  if (inherited != null && !IGNORED_INHERITED_PORTS.has(inherited)) return inherited;
  return DEFAULT_SERVER_PORT;
}
