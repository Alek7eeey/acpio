import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * One acpio per database file. Two servers on the same `acpio.db` share the
 * rows but not the runtimes: the second boot reads the first one's live turn as
 * a stale "running" row, resets it to idle and re-drives that chat in its own
 * process. When the duplicate turn ends it writes `status: "idle"` over the
 * live turn's claim — so a later restart of the real server no longer sees an
 * interrupted turn and the chat is never continued.
 *
 * The claim is a sibling `<db>.lock` file holding the owner's pid, created
 * exclusively: a second start refuses and names the holder, while a killed
 * owner's file is taken over because its pid is gone.
 */

type LockOwner = { pid: number; startedAt: number };

/** `:memory:` (tests) is private to its process — nothing to claim. */
export function lockPathFor(dbPath: string): string | null {
  return dbPath === ":memory:" ? null : `${dbPath}.lock`;
}

/** How long a start waits for the previous owner to actually die (SIGTERM in
 *  flight, `tsx watch` reload) before declaring the database taken. */
const OWNER_EXIT_GRACE_MS = 250;
const OWNER_EXIT_ATTEMPTS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process is there, it just belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const IS_WIN = process.platform === "win32";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd}: exit ${code}`))));
  });
}

type ProcNode = { pid: number; ppid: number; cmd: string };

/** pid → … → highest readable ancestor, one hop per entry. */
async function readChain(pid: number): Promise<ProcNode[]> {
  if (IS_WIN) {
    // One powershell call walks the whole chain — a per-hop spawn would cost a second each.
    const script =
      `$t = ${pid}; ` +
      "for ($i = 0; $i -lt 14 -and $t; $i++) { " +
      '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$t"; if (-not $p) { break }; ' +
      "  Write-Output ($p.ProcessId.ToString() + [char]9 + $p.ParentProcessId.ToString() + [char]9 + $p.CommandLine); " +
      "  $t = $p.ParentProcessId " +
      "}";
    try {
      const out = await run("powershell.exe", ["-NoProfile", "-Command", script]);
      return out
        .split(/\r?\n/)
        .filter((line) => line.includes("\t"))
        .map((line) => {
          const [p, pp, ...rest] = line.split("\t");
          return { pid: Number(p), ppid: Number(pp), cmd: rest.join("\t") };
        });
    } catch {
      return [];
    }
  }
  const nodes: ProcNode[] = [];
  let cur = pid;
  for (let i = 0; i < 14 && cur > 1; i++) {
    try {
      const cmd = (await fs.promises.readFile(`/proc/${cur}/cmdline`, "utf8")).replace(/\0/g, " ");
      const stat = await fs.promises.readFile(`/proc/${cur}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      nodes.push({ pid: cur, ppid, cmd });
      cur = ppid;
    } catch {
      break;
    }
  }
  return nodes;
}

/** A chain belongs to acp/acpio when some hop names the repo or the workspace. */
function looksLikeAcpio(chain: ProcNode[]): boolean {
  return chain.some((node) => /acprocess[\\/]|@acpio\/|acpio\.db/.test(node.cmd));
}

/**
 * Takeover (human-only, ACPIO_TAKEOVER=1): kill the live holder's whole process
 * tree — the tree, because a watch parent (tsx watch, concurrently) would just
 * respawn the child — then let the caller claim the freed lock.
 */
async function killHolderTree(holderPid: number): Promise<void> {
  const chain = await readChain(holderPid);
  if (!chain.length) {
    throw new Error(`ACPIO_TAKEOVER: pid ${holderPid} command line unreadable — refusing to kill it.`);
  }
  // Never kill our own launch chain: if the holder hangs off our ancestors the
  // shared nodes are dropped and only the foreign part of the tree is taken.
  const own = new Set((await readChain(process.pid)).map((node) => node.pid));
  const foreign = chain.filter((node) => !own.has(node.pid));
  if (!foreign.length) {
    throw new Error(`ACPIO_TAKEOVER: pid ${holderPid} is our own ancestor — refusing to kill it.`);
  }
  // Identity is judged on the foreign part only: our own ancestors (e.g. the
  // acpio we were started from) must not vouch for a stranger's pid.
  if (!looksLikeAcpio(foreign)) {
    throw new Error(
      `ACPIO_TAKEOVER: pid ${holderPid} does not look like an acpio process ` +
        `(${chain[0].cmd.trim() || "command line unreadable"}) — refusing to kill it.`,
    );
  }
  const top = foreign[foreign.length - 1].pid;
  if (IS_WIN) {
    // /T down from the root: the holder dies with the tree, no respawn window.
    await run("taskkill.exe", ["/PID", String(top), "/T", "/F"]).catch(() => undefined);
  } else {
    for (const node of [...foreign].reverse()) {
      try {
        process.kill(node.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  for (let i = 0; i < 40 && isProcessAlive(holderPid); i++) await sleep(50);
  if (isProcessAlive(holderPid)) {
    throw new Error(`ACPIO_TAKEOVER: pid ${holderPid} survived the kill — the database stays with it.`);
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    if (typeof raw?.pid !== "number") return null;
    return { pid: raw.pid, startedAt: Number(raw.startedAt) || 0 };
  } catch {
    return null;
  }
}

/** Drop this process's claim. A killed process never gets here — its file is
 *  taken over by the next start instead. */
export function releaseInstanceLock(dbPath: string): void {
  const lockPath = lockPathFor(dbPath);
  if (!lockPath) return;
  const owner = readOwner(lockPath);
  if (owner && owner.pid !== process.pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

export type AcquireOptions = {
  /**
   * Human-only escape hatch (ACPIO_TAKEOVER=1): instead of refusing when a live
   * instance holds the database, kill that instance's process tree and take the
   * lock anyway. Never start an agent or CI with this — it force-kills whoever
   * holds the lock, and a second live server on one database is exactly what
   * this lock exists to prevent. Only a person who decided "that instance is
   * wrong, this one wins" may pass it.
   */
  takeover?: boolean;
};

/**
 * Claim the database for this process, or throw once a live instance holds it.
 * A stale file (crash, taskkill, reload) is taken over.
 */
export async function acquireInstanceLock(dbPath: string, options: AcquireOptions = {}): Promise<void> {
  const lockPath = lockPathFor(dbPath);
  if (!lockPath) return;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let takeoverTried = false;
  for (let attempt = 0; attempt < OWNER_EXIT_ATTEMPTS; attempt++) {
    const owner: LockOwner = { pid: process.pid, startedAt: Date.now() };
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, JSON.stringify(owner));
      } finally {
        fs.closeSync(fd);
      }
      process.once("exit", () => releaseInstanceLock(dbPath));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const held = readOwner(lockPath);
    if (held && held.pid !== process.pid && isProcessAlive(held.pid)) {
      if (options.takeover && !takeoverTried) {
        takeoverTried = true;
        await killHolderTree(held.pid);
        continue; // holder is dead: the next pass unlinks its stale file and claims
      }
      // The holder may be on its way out (a restart kills and respawns us);
      // give it a moment before refusing.
      if (attempt < OWNER_EXIT_ATTEMPTS - 1) {
        await sleep(OWNER_EXIT_GRACE_MS);
        continue;
      }
      throw new Error(
        `acpio is already running on ${dbPath} (pid ${held.pid}) — two servers must not share one database: ` +
          "the second one re-drives live chats and overwrites their turn status. Stop the other instance, or " +
          "point this one at another file via DATABASE_PATH.",
      );
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* raced with the owner's own release */
    }
  }
  throw new Error(`Could not claim ${lockPath} — remove the file and start again.`);
}