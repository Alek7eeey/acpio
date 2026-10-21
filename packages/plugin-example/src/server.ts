/**
 * Example acpio plugin — also the seed of the future `acpio-plugin init`
 * template. Keep it one file: `tsc` then emits `dist/server.js` with no imports
 * left, which is what the host needs (the cache directory has no node_modules,
 * so a bundle that still imports its own dependencies cannot be loaded).
 */
import type {
  JsonObject,
  PluginBundle,
  PluginMcpServer,
  PluginTool,
} from "@acpio/plugin-api";

const tools: Record<string, PluginTool> = {
  greet: {
    description: "Greet someone by name, with the greeting this plugin is configured with.",
    schema: {
      type: "object",
      properties: { name: { type: "string", description: "Who to greet" } },
      required: ["name"],
    },
    readOnly: true,
    handler: async (input) => {
      const { name } = (input ?? {}) as { name?: unknown };
      return `${greeting} ${String(name ?? "there")}!`;
    },
  },
};

/** Set when the plugin is created, read by `greet`. */
let greeting = "Hello";

const bundle: PluginBundle = (ctx) => {
  const config = ctx.config as JsonObject;
  const mcp = (config.mcp ?? {}) as JsonObject;
  greeting = String((mcp.demo as JsonObject)?.greeting ?? "Hello");
  ctx.log.info(`example plugin: greeting = ${greeting}`);

  return {
    id: "example",
    extensions: [
      {
        mcpServer: {
          id: "demo",
          label: "Example tools",
          description: "Two lines of code that give the agent a tool — replace with your own.",
          config: { defaults: { greeting: "Hello" }, sample: { greeting: "Привет" } },
          isConfigured: (merged) => Boolean(String(merged.greeting ?? "").trim()),
          create: (serverCtx): PluginMcpServer => {
            greeting = String(serverCtx.config.greeting ?? greeting);
            return { tools };
          },
        },
        modelProvider: {
          id: "demo",
          label: "Demo provider",
          description: "An OpenAI-compatible endpoint shipped with the plugin — paste a key.",
          baseUrl: "https://example.invalid/v1",
          apiKeyHint: "https://example.invalid/keys",
          models: [
            { id: "demo-small", label: "Demo Small", contextWindow: 131_072 },
            { id: "demo-large", label: "Demo Large", contextWindow: 262_144 },
          ],
        },
      },
    ],
  };
};

export default bundle;
