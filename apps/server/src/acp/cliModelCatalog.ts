import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  modelDisplayName,
  type AgentProvider,
  type AppSettings,
  type ModelOption,
} from "@acpio/shared";
import { adapterCommand, getAdapter } from "../adapters/registry.js";
import { resolveCommand } from "./AcpClient.js";

const execFileAsync = promisify(execFile);

/** Model lists must match the CLI without injected BYOK keys. */
function buildCliCatalogEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CURSOR_API_KEY;
  return env;
}

/** Run the harness's CLI with the given args; returns stdout. */
export async function runAgentCli(
  provider: AgentProvider,
  settings: AppSettings,
  args: string[],
): Promise<string> {
  const adapter = getAdapter(provider);
  const commandName = adapterCommand(adapter, settings);
  const resolved = await resolveCommand(commandName, adapter);
  const env = buildCliCatalogEnv();
  const { stdout } = await execFileAsync(resolved.cmd, args, {
    env,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    shell: resolved.shell,
  });
  return stdout;
}

/**
 * Broader catalog than the ACP option list — delegated to the harness adapter
 * (OMP exposes a cloud-backed `models --json`; others return null).
 */
export async function fetchAuthoritativeModelCatalog(
  provider: AgentProvider,
  settings: AppSettings,
): Promise<ModelOption[] | null> {
  const adapter = getAdapter(provider);
  if (!adapter.probeModels) return null;
  try {
    return await adapter.probeModels({
      settings,
      runCli: (args) => runAgentCli(provider, settings, args),
    });
  } catch (err) {
    console.warn(`[models] CLI catalog failed for ${provider}:`, err);
    return null;
  }
}

export function preferAuthoritativeModels(
  acpModels: ModelOption[],
  cliModels: ModelOption[] | null,
): ModelOption[] {
  if (!cliModels?.length) return acpModels;
  const acpByValue = new Map(acpModels.map((m) => [m.value, m]));
  return cliModels.map((m) => {
    const acp = acpByValue.get(m.value);
    return {
      value: m.value,
      name: m.name || acp?.name || modelDisplayName(m.value),
      provider: m.provider ?? acp?.provider,
    };
  });
}

export async function reconcileModelCatalog(
  provider: AgentProvider,
  settings: AppSettings,
  acpModels: ModelOption[],
): Promise<ModelOption[]> {
  const cliModels = await fetchAuthoritativeModelCatalog(provider, settings);
  return preferAuthoritativeModels(acpModels, cliModels);
}
