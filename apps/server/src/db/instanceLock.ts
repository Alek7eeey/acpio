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

/**
 * Claim the database for this process, or throw once a live instance holds it.
 * A stale file (crash, taskkill, reload) is taken over.
 */
export async function acquireInstanceLock(dbPath: string): Promise<void> {
  const lockPath = lockPathFor(dbPath);
  if (!lockPath) return;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
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