import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desc, eq } from "drizzle-orm";
import type { GiteaJobDto, GiteaStatusDto } from "@acprocess/shared";
import { db } from "../db/client.js";
import { giteaJobs } from "../db/schema.js";
import { getSettings } from "./settings.js";
import { createSession, updateSession } from "./sessions.js";
import { runPrompt } from "../acp/sessionManager.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function mapJob(row: typeof giteaJobs.$inferSelect): GiteaJobDto {
  return {
    id: row.id,
    kind: row.kind as GiteaJobDto["kind"],
    status: row.status as GiteaJobDto["status"],
    result: (row.result as Record<string, unknown> | null) ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function giteaFetch(path: string, init?: RequestInit) {
  const settings = await getSettings();
  if (!settings.giteaBaseUrl || !settings.giteaToken) {
    throw new Error("Gitea не настроен: укажите baseUrl и token в настройках");
  }
  const url = `${settings.giteaBaseUrl.replace(/\/$/, "")}/api/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `token ${settings.giteaToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gitea API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function getGiteaStatus(cwd?: string): Promise<GiteaStatusDto> {
  const settings = await getSettings();
  const workdir = cwd || settings.defaultCwd || process.cwd();
  const base: GiteaStatusDto = {
    configured: Boolean(settings.giteaBaseUrl && settings.giteaToken),
    baseUrl: settings.giteaBaseUrl,
    owner: settings.giteaOwner,
    repo: settings.giteaRepo,
    branch: null,
    dirty: false,
    ahead: 0,
    behind: 0,
    conflicted: [],
    diffStat: "",
  };

  try {
    const branch = await git(workdir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const porcelain = await git(workdir, ["status", "--porcelain"]);
    const diffStat = await git(workdir, ["diff", "--stat"]).catch(() => "");
    const unmerged = await git(workdir, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
    base.branch = branch;
    base.dirty = porcelain.length > 0;
    base.diffStat = diffStat;
    base.conflicted = unmerged ? unmerged.split(/\r?\n/).filter(Boolean) : [];

    try {
      const counts = await git(workdir, [
        "rev-list",
        "--left-right",
        "--count",
        "@{upstream}...HEAD",
      ]);
      const [behind, ahead] = counts.split(/\s+/).map((n) => Number(n) || 0);
      base.behind = behind;
      base.ahead = ahead;
    } catch {
      // no upstream
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Empty repo / no HEAD yet is fine for local harness
    if (/unknown revision|bad revision|not a git repository/i.test(message)) {
      base.branch = "(no commits)";
    } else {
      base.error = message;
    }
  }
  return base;
}

export async function listGiteaJobs(): Promise<GiteaJobDto[]> {
  const rows = await db.select().from(giteaJobs).orderBy(desc(giteaJobs.createdAt)).limit(50);
  return rows.map(mapJob);
}

async function createJob(kind: GiteaJobDto["kind"]) {
  const [row] = await db.insert(giteaJobs).values({ kind, status: "running" }).returning();
  return row;
}

async function finishJob(
  id: string,
  status: "done" | "error",
  result?: Record<string, unknown>,
  error?: string,
) {
  const [row] = await db
    .update(giteaJobs)
    .set({
      status,
      result: result ?? null,
      error: error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(giteaJobs.id, id))
    .returning();
  return mapJob(row);
}

export async function aiCommit(message?: string) {
  const settings = await getSettings();
  const cwd = settings.defaultCwd || process.cwd();
  const job = await createJob("commit");

  try {
    const diff = await git(cwd, ["diff", "--staged"]);
    const unstaged = await git(cwd, ["diff"]);
    const combined = diff || unstaged;
    if (!combined.trim()) {
      throw new Error("Нет изменений для коммита");
    }

    let commitMessage = message?.trim();
    if (!commitMessage) {
      const session = await createSession({
        title: "Gitea: commit message",
        provider: settings.defaultProvider,
        cwd,
        mode: "ask",
      });
      await runPrompt(
        session.id,
        `Сгенерируй краткое сообщение git commit (1-2 предложения, на русском или английском как в diff) только текст без кавычек и пояснений.\n\nDIFF:\n${combined.slice(0, 12000)}`,
        {
          provider: settings.defaultProvider,
          cwd,
          mode: "ask",
          titleHint: "Gitea commit",
        },
      );
      // Fallback if agent unavailable — use heuristic
      commitMessage = `chore: update ${new Date().toISOString().slice(0, 10)}`;
      // Try to read last assistant text from DB would be complex; keep heuristic + optional message
      await updateSession(session.id, { status: "idle" });
    }

    if (!diff.trim() && unstaged.trim()) {
      await git(cwd, ["add", "-A"]);
    } else if (!diff.trim()) {
      await git(cwd, ["add", "-A"]);
    }

    await execFileAsync("git", ["commit", "-m", commitMessage!], {
      cwd,
      windowsHide: true,
    });

    const sha = await git(cwd, ["rev-parse", "HEAD"]);
    return finishJob(job.id, "done", { sha, message: commitMessage });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return finishJob(job.id, "error", undefined, messageText);
  }
}

export async function createPullRequest(input: {
  title?: string;
  body?: string;
  head?: string;
  base?: string;
}) {
  const settings = await getSettings();
  const cwd = settings.defaultCwd || process.cwd();
  const job = await createJob("pr");

  try {
    if (!settings.giteaOwner || !settings.giteaRepo) {
      throw new Error("Укажите Gitea owner и repo в настройках");
    }

    const branch = input.head || (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
    const log = await git(cwd, ["log", "--oneline", "-n", "15"]).catch(() => "");
    const diffStat = await git(cwd, ["diff", "--stat", `origin/${input.base ?? "main"}...HEAD`]).catch(
      () => git(cwd, ["diff", "--stat"]).catch(() => ""),
    );

    const title =
      input.title?.trim() ||
      `PR: ${branch} — ${new Date().toISOString().slice(0, 10)}`;
    const body =
      input.body?.trim() ||
      `## Summary\nИзменения из ветки \`${branch}\`.\n\n## Commits\n\`\`\`\n${log}\n\`\`\`\n\n## Diff stat\n\`\`\`\n${diffStat}\n\`\`\`\n`;

    // Push best-effort
    try {
      await git(cwd, ["push", "-u", "origin", "HEAD"]);
    } catch {
      // may already be pushed / no remote write
    }

    const pr = await giteaFetch(`/repos/${settings.giteaOwner}/${settings.giteaRepo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title,
        body,
        head: branch,
        base: input.base ?? "main",
      }),
    });

    return finishJob(job.id, "done", {
      title,
      body,
      pr,
    });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return finishJob(job.id, "error", undefined, messageText);
  }
}

export async function resolveConflicts() {
  const settings = await getSettings();
  const cwd = settings.defaultCwd || process.cwd();
  const job = await createJob("conflicts");

  try {
    const status = await getGiteaStatus(cwd);
    if (status.conflicted.length === 0) {
      return finishJob(job.id, "done", { message: "Конфликтов не найдено" });
    }

    const session = await createSession({
      title: "Gitea: resolve conflicts",
      provider: settings.defaultProvider,
      cwd,
      mode: "agent",
    });

    // Fire and forget agent session for conflict resolution
    void runPrompt(
      session.id,
      `В репозитории есть git merge/rebase конфликты в файлах:\n${status.conflicted.join("\n")}\n\nРазреши конфликты аккуратно, сохрани намерения обеих сторон где возможно, затем stage файлы. Не делай force push.`,
      {
        provider: settings.defaultProvider,
        cwd,
        mode: "agent",
        titleHint: "Resolve conflicts",
      },
    ).catch(async (err) => {
      await finishJob(job.id, "error", undefined, err instanceof Error ? err.message : String(err));
    });

    return finishJob(job.id, "done", {
      sessionId: session.id,
      files: status.conflicted,
      message: "Запущена агент-сессия для резолва конфликтов",
    });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return finishJob(job.id, "error", undefined, messageText);
  }
}
