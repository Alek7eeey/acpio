import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Reads the file list off this machine's clipboard — the files a reader copied
 * in Explorer.
 *
 * The browser cannot: Chromium hides a copied file list from
 * `navigator.clipboard.read()` (it answers one item with no types at all, so a
 * menu row looking for a file finds nothing), and only a real `paste` event
 * carries the files — which a click cannot raise. Acpio's server runs on the
 * same machine, so it asks the OS instead, and the file is attached by path:
 * nothing is uploaded and no size limit applies.
 *
 * Windows only; anything else answers "no files", and the reader's Ctrl+V —
 * the paste event, which does carry files — is the way through.
 */
export async function clipboardFilePaths(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // A copied file list has no text form, so this is the only question to
        // ask. UTF-8 on the way out: the console's own code page mangles Cyrillic
        // names, and those are most of them here.
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }",
      ],
      { timeout: 10_000, windowsHide: true, maxBuffer: 1 << 20 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // No file list on the clipboard (it holds text, a picture, or nothing), or
    // no PowerShell on this machine: there is nothing to paste.
    return [];
  }
}

/** The clipboard's files as attachments: a name the composer can show and the
 *  path the agent will read. */
export async function clipboardAttachments(): Promise<Array<{ name: string; path: string }>> {
  const paths = await clipboardFilePaths();
  return paths.map((file) => ({ name: path.basename(file), path: file }));
}
