#!/usr/bin/env node
/**
 * Prompt lab — the built-in agent's system prompt, rendered by the real code,
 * with the knobs the settings page spreads over several screens, and a delta
 * for every step.
 *
 *   npm run build            # the lab imports packages/adapter-builtin/dist
 *   node scripts/prompt-lab.mjs [--port 4599]
 *
 * It starts from the app's CURRENT settings (a running server first, its SQLite
 * file otherwise) and never writes them: the knobs are a sandbox on top, so
 * trying "what if images were off" cannot change the app.
 *
 * What the lab composes itself is exactly what `BuiltinAgent.prompt()` composes:
 * servers list, skills section, superseded rules, extra instructions + the
 * thinking blurb, in that order. Anything else comes from the package.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "packages", "adapter-builtin", "dist");

const portArg = process.argv.indexOf("--port");
const PORT = Number(
  (portArg > 0 ? process.argv[portArg + 1] : null) ?? process.env.PROMPT_LAB_PORT ?? 4599,
);
const APP = process.env.ACPIO_URL ?? "http://127.0.0.1:3002";

const load = async (name) => {
  try {
    return await import(pathToFileURL(path.join(DIST, name)).href);
  } catch (err) {
    console.error(`the lab reads the built adapter (${path.join(DIST, name)}): ${err.message}`);
    console.error("run `npm run build` first");
    process.exit(1);
  }
};
const agent = await load("agent.js");
const skills = await load("skills.js");

/** The app's settings: a live server if there is one, its database otherwise. */
async function baseSettings() {
  try {
    const res = await fetch(`${APP}/api/settings`);
    if (res.ok) return { ...(await res.json()), source: `server ${APP}` };
  } catch {}
  const db = require("better-sqlite3")(path.join(ROOT, "data", "acpio.db"), { readonly: true });
  const row = db.prepare("select value from settings where key = 'app'").get();
  db.close();
  if (!row?.value) throw new Error("no settings: start the app once, or pass ACPIO_URL");
  return { ...JSON.parse(row.value), source: "data/acpio.db" };
}

const base = await baseSettings();
const cwd = base.defaultCwd || ROOT;

/** MCP servers the agent would be handed: the built-in one plus the user's own. */
function mcpServers() {
  const list = new Set();
  if (!(base.mcpBuiltinDisabledIds ?? []).includes("builtin:acpio_bg")) list.add("acpio_bg");
  for (const server of base.mcpServers ?? []) {
    if (server?.enabled === false || !server?.name) continue;
    list.add(server.name);
  }
  return [...list].map((name) => ({ name, on: true }));
}

async function defaults() {
  const found = await skills.discoverSettingsSkills(base, cwd);
  return {
    source: base.source,
    cwd,
    locale: base.locale === "en" ? "en" : "ru",
    thinking: "default",
    outsideCwd: base.builtinAllowOutsideCwd === true,
    markdownImages: base.builtinMarkdownImages === true,
    plugin: (base.pluginSkills ?? []).length > 0,
    extra: base.builtinExtraInstructions ?? "",
    mcp: mcpServers(),
    skills: found.map((skill) => ({
      name: skill.name,
      builtin: skill.builtin === true,
      mode: skills.skillMode(base.builtinSkillModes, skill.name),
      // `disable-model-invocation: true` keeps it out of the prompt whatever the
      // mode says, so the panel has to show that or a mode change looks broken.
      advertised: skill.disableModelInvocation !== true,
    })),
  };
}

async function promptFor(state) {
  const settings = {
    ...base,
    locale: state.locale,
    pluginSkills: state.plugin ? (base.pluginSkills ?? []) : [],
  };
  const found = await skills.discoverSettingsSkills(settings, state.cwd || cwd);
  // The page holds modes as a name→mode map, `/state` hands them out as rows; both
  // have to mean the same thing or a state round-trip silently lists every skill.
  const modes = Array.isArray(state.skills)
    ? Object.fromEntries(state.skills.map((row) => [row.name, row.mode]))
    : (state.skills ?? {});
  const superseded = skills.supersededRules(found, modes);
  const prompt = agent.systemPrompt(
    state.locale,
    state.cwd || cwd,
    { servers: (state.mcp ?? []).filter((row) => row.on).map((row) => row.name) },
    await skills.renderSkillsSection(found, modes),
    superseded,
    state.outsideCwd === true,
    state.markdownImages === true,
    state.extra ?? "",
    agent.THINKING_INSTRUCTIONS[state.thinking] ?? "",
  );
  return {
    prompt,
    superseded: [...superseded],
    rules: agent.RULE_IDS,
    skills: found.map((skill) => ({
      name: skill.name,
      mode: skills.skillMode(modes, skill.name),
      supersedes: skill.supersedes,
    })),
  };
}

const send = (res, status, type, body) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const json = (res, value, status = 200) => send(res, status, "application/json", JSON.stringify(value));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, "text/html; charset=utf-8", readFileSync(path.join(HERE, "prompt-lab.page.html"), "utf8"));
    }
    if (url.pathname === "/favicon.ico") return send(res, 204, "text/plain", "");
    if (req.method === "GET" && url.pathname === "/diff.mjs") {
      return send(res, 200, "text/javascript; charset=utf-8", readFileSync(path.join(HERE, "prompt-lab.diff.mjs"), "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/state") return json(res, await defaults());
    if (req.method === "POST" && url.pathname === "/prompt") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const state = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return json(res, await promptFor(state));
    }
    return json(res, { error: "not found" }, 404);
  } catch (err) {
    return json(res, { error: String(err?.message ?? err) }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`settings: ${base.source}`);
  console.log(`prompt lab: http://127.0.0.1:${PORT}`);
});
