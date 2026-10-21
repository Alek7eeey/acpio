import { randomBytes } from "node:crypto";

/**
 * Token this boot hands to the MCP endpoints acpio serves itself
 * (`/api/mcp/plugin/...`). CORS is open, so without it any web page could POST
 * to an endpoint that runs plugin code on this machine. It lives in memory
 * only: a new boot means a new token, and every URL carrying it is rebuilt
 * before `session/new`.
 */
export const MCP_TOKEN = randomBytes(16).toString("hex");

/** True when the request carries the token this boot handed out. */
export function mcpTokenMatches(token: string | undefined): boolean {
  return typeof token === "string" && token.length > 0 && token === MCP_TOKEN;
}
