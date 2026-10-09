import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PICK_TIMEOUT_MS = 5 * 60 * 1000;

/** Default folder dialog location on the machine running the API. */
export function defaultPickerPath(): string {
  return os.homedir();
}

async function resolvePickerStartPath(initialPath?: string): Promise<string> {
  const trimmed = (initialPath ?? "").trim();
  if (trimmed) {
    try {
      const resolved = path.resolve(trimmed);
      if ((await fs.stat(resolved)).isDirectory()) {
        return resolved;
      }
    } catch {
      // fall through to server home
    }
  }
  return defaultPickerPath();
}

function run(
  command: string,
  args: string[],
  opts?: { shell?: boolean; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: opts?.shell ?? false,
      env: opts?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Диалог выбора папки превысил время ожидания"));
    }, PICK_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function normalizePicked(raw: string): Promise<string | null> {
  const trimmed = raw.trim().replace(/^file:\/\//i, "");
  if (!trimmed) return null;
  try {
    const resolved = path.resolve(trimmed);
    if (!(await fs.stat(resolved)).isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function pickWindows(initialPath?: string): Promise<string | null> {
  const initial = (await resolvePickerStartPath(initialPath)).replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Выберите рабочую папку'
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = '${initial}'
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.Write($dialog.SelectedPath)
}
`;
  const { stdout } = await run("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  return normalizePicked(stdout);
}

async function pickMac(initialPath?: string): Promise<string | null> {
  const initial = (await resolvePickerStartPath(initialPath)).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script =
    "try\n" +
    `  set defaultLocation to POSIX file "${initial}"\n` +
    '  set p to POSIX path of (choose folder with prompt "Выберите рабочую папку" default location defaultLocation)\n' +
    "  return p\n" +
    "on error\n" +
    '  return ""\n' +
    "end try";
  const { stdout } = await run("osascript", ["-e", script]);
  return normalizePicked(stdout);
}

async function pickLinux(initialPath?: string): Promise<string | null> {
  const initial = await resolvePickerStartPath(initialPath);
  const args = ["--file-selection", "--directory", "--title=Выберите рабочую папку"];
  args.push(`--filename=${initial}`);
  try {
    const { code, stdout } = await run("zenity", args);
    if (code !== 0) return null;
    return await normalizePicked(stdout);
  } catch {
    try {
      const kdialogArgs = ["--getexistingdirectory", initial];
      const { code, stdout } = await run("kdialog", kdialogArgs);
      if (code !== 0) return null;
      return await normalizePicked(stdout);
    } catch {
      throw new Error(
        "Не найден zenity/kdialog для выбора папки. Установите один из них или укажите путь вручную.",
      );
    }
  }
}

/** Open a native OS folder dialog and return the absolute path, or null if cancelled. */
export async function pickDirectory(initialPath?: string): Promise<string | null> {
  if (process.platform === "win32") return pickWindows(initialPath);
  if (process.platform === "darwin") return pickMac(initialPath);
  return pickLinux(initialPath);
}
