import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  modelDisplayName,
  providerCommand,
  usesCloudModelCatalog,
  type AgentProvider,
  type AppSettings,
} from "@acprocess/shared";
import { resolveCommand } from "./AcpClient.js";

const execFileAsync = promisify(execFile);

export type ModelOption = { value: string; name: string };

/** OMP model lists must match the CLI without injected BYOK keys. */
function buildCliCatalogEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CURSOR_API_KEY;
  if (process.platform === "win32") {
    const extras: string[] = [];
    if (process.env.LOCALAPPDATA) {
      extras.push(path.join(process.env.LOCALAPPDATA, "cursor-agent"));
      extras.push(path.join(process.env.LOCALAPPDATA, "omp"));
    }
    if (process.env.USERPROFILE) {
      extras.push(path.join(process.env.USERPROFILE, ".local", "bin"));
    }
    if (process.env.APPDATA) {
      extras.push(path.join(process.env.APPDATA, "npm"));
    }
    env.PATH = `${extras.join(";")};${env.PATH ?? ""}`;
  }
  return env;
}

async function runAgentCli(
  provider: AgentProvider,
  settings: AppSettings,
  args: string[],
): Promise<string> {
  const commandName = providerCommand(settings, provider);
  const resolved = await resolveCommand(commandName);
  const env = buildCliCatalogEnv();
  const { stdout } = await execFileAsync(resolved.cmd, args, {
    env,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    shell: resolved.shell,
  });
  return stdout;
}

async function fetchOmpModels(settings: AppSettings): Promise<ModelOption[]> {
  const stdout = await runAgentCli("omp", settings, ["models", "--json"]);
  const parsed = JSON.parse(stdout) as {
    models?: Array<{
      selector?: string;
      provider?: string;
      id?: string;
      name?: string;
    }>;
  };
  const rows = parsed.models ?? [];
  return rows
    .map((row) => {
      const value =
        row.selector?.trim() ||
        (row.provider && row.id ? `${row.provider}/${row.id}` : row.id?.trim() || "");
      if (!value) return null;
      return {
        value,
        name: row.name?.trim() || modelDisplayName(value),
      };
    })
    .filter((m): m is ModelOption => m != null);
}

/** OMP ACP can expose a broader catalog than the CLI `models` command. */
export async function fetchAuthoritativeModelCatalog(
  provider: AgentProvider,
  settings: AppSettings,
): Promise<ModelOption[] | null> {
  if (!usesCloudModelCatalog(provider)) return null;
  try {
    if (provider === "omp") return await fetchOmpModels(settings);
  } catch (err) {
    console.warn(`[models] CLI catalog failed for ${provider}:`, err);
  }
  return null;
}

export function preferAuthoritativeModels(
  acpModels: ModelOption[],
  cliModels: ModelOption[] | null,
): ModelOption[] {
  if (!cliModels?.length) return acpModels;
  const acpNames = new Map(acpModels.map((m) => [m.value, m.name]));
  return cliModels.map((m) => ({
    value: m.value,
    name: m.name || acpNames.get(m.value) || modelDisplayName(m.value),
  }));
}

export async function reconcileModelCatalog(
  provider: AgentProvider,
  settings: AppSettings,
  acpModels: ModelOption[],
): Promise<ModelOption[]> {
  const cliModels = await fetchAuthoritativeModelCatalog(provider, settings);
  return preferAuthoritativeModels(acpModels, cliModels);
}
