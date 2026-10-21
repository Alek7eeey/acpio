/**
 * The environment a process acpio spawns on someone's behalf: a shell for the
 * agent, a background job, an MCP server, the user's console.
 *
 * acpio's server is normally started by `npm start`, and npm exports its own
 * invocation into the environment of everything it starts — `NPM_CONFIG_*` for
 * every npmrc setting, plus `NPM_PACKAGE_*`, `NPM_LIFECYCLE_*`, `NPM_EXECPATH`.
 * Those describe the *parent's* run, but npm reads them back as its own state:
 * a nested `npm install` in a project dies with `EALLOWSCRIPTS` because the
 * leaked `npm_config_allow_scripts` looks like a flag of that very command, and
 * `npm_config_local_prefix` aims the install at the parent's folder. npm's
 * configuration belongs to npmrc files, which the child npm reads for itself.
 */
export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase().startsWith("npm_")) continue;
    out[key] = value;
  }
  return out;
}
