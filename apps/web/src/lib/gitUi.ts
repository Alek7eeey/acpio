import type { GitChangedFileDto, GitStatusDto, SessionStatus } from "@acpio/shared";

/** Single-letter git status badge (never "??"). */
export function gitStatusBadge(file: GitChangedFileDto): string {
  if (file.index === "?" && file.worktree === "?") return "?";
  if (file.index === "U" || file.worktree === "U") return "U";
  if (file.staged && file.unstaged) {
    const left = file.index.trim();
    const right = file.worktree.trim();
    return left && right && left !== right ? `${left}${right}` : left || right || "M";
  }
  if (file.staged) return file.index.trim() || "A";
  return file.worktree.trim() || "?";
}

export function isGitConflictFile(file: GitChangedFileDto): boolean {
  return (
    file.index === "U" ||
    file.worktree === "U" ||
    (file.index === "A" && file.worktree === "A") ||
    (file.index === "D" && file.worktree === "D")
  );
}

export function gitConflictFiles(status: GitStatusDto | null | undefined): GitChangedFileDto[] {
  return status?.files.filter(isGitConflictFile) ?? [];
}

export function gitPullConflictMessage(
  count: number,
  t: (key: "git.pullConflicts", vars?: Record<string, string>) => string,
) {
  return t("git.pullConflicts", { count: String(count) });
}

export function shouldAwaitGitRepo(input: {
  loading: boolean;
  status: GitStatusDto | null;
  hasCwd: boolean;
  sessionStatus?: SessionStatus;
  streaming?: boolean;
  isEmptyChat?: boolean;
}) {
  if (input.loading) return true;
  if (!input.hasCwd) return false;
  if (input.status?.repo) return false;
  if (input.status && input.status.repo === false) return false;
  if (input.sessionStatus === "error" || input.sessionStatus === "closed") return false;
  if (input.streaming || input.sessionStatus === "running" || input.sessionStatus === "waiting") return true;
  if (input.isEmptyChat && input.sessionStatus === "idle") return false;
  if (input.isEmptyChat) return true;
  return false;
}

/** Show git chip / composer branch bar only for repos, or while status is still loading. */
export function shouldShowGitComposerUi(input: {
  loading: boolean;
  awaiting: boolean;
  status: GitStatusDto | null;
  hasCwd?: boolean;
}) {
  if (!input.hasCwd) return false;
  if (input.status?.repo) return true;
  if (input.status && input.status.repo === false) return false;
  return input.loading || input.awaiting;
}

export function formatDiffStats(additions: number, deletions: number): string {
  return `+${additions} -${deletions}`;
}

export type GitSyncOutput = {
  pullRequestUrl?: string;
  branch?: string;
  range?: string;
  isNewBranch?: boolean;
};

/** Extract useful bits from git fetch/pull/push stderr (remote: …, To …, ref updates). */
export function parseGitSyncOutput(output: string): GitSyncOutput {
  const lines = output.split("\n");
  let pullRequestUrl: string | undefined;
  let branch: string | undefined;
  let range: string | undefined;
  let isNewBranch = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^remote:/i.test(line)) {
      const remoteBody = line.replace(/^remote:\s*/i, "");
      const url = remoteBody.match(/(https?:\/\/\S+)/)?.[1];
      if (url && (/\/pulls?\//.test(url) || /pull request/i.test(remoteBody))) {
        pullRequestUrl = url.replace(/[.,;]+$/, "");
      }
    }

    const newBranchMatch = line.match(/^\*\s*\[new branch\]\s+(\S+)\s+->\s+(\S+)/i);
    if (newBranchMatch) {
      isNewBranch = true;
      branch = newBranchMatch[2] ?? newBranchMatch[1];
      continue;
    }

    const refMatch = line.match(/^([0-9a-f]{7,40}\.\.[0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)/i);
    if (refMatch) {
      range = refMatch[1];
      branch = refMatch[2];
    }
  }

  return { pullRequestUrl, branch, range, isNewBranch };
}

export type GitSyncFeedback = {
  text: string;
  href?: string;
  hrefLabel?: string;
};

export function buildGitSyncFeedback(
  action: "fetch" | "pull" | "push",
  output: string,
  t: (
    key:
      | "git.syncOk"
      | "git.fetchOk"
      | "git.pullOk"
      | "git.pushOk"
      | "git.pushOkShort"
      | "git.pushOkNewBranch"
      | "git.pushOkGeneric"
      | "git.openPullRequest",
    vars?: Record<string, string>,
  ) => string,
): GitSyncFeedback {
  const trimmed = output.trim();
  if (action === "push") {
    if (trimmed) {
      const parsed = parseGitSyncOutput(trimmed);
      if (parsed.branch) {
        const shortRange = parsed.range?.replace(
          /([0-9a-f]{7})[0-9a-f]*\.\.([0-9a-f]{7})[0-9a-f]*/i,
          "$1…$2",
        );
        const text = parsed.isNewBranch
          ? t("git.pushOkNewBranch", { branch: parsed.branch })
          : shortRange
            ? t("git.pushOk", { branch: parsed.branch, range: shortRange })
            : t("git.pushOkShort", { branch: parsed.branch });
        return {
          text,
          href: parsed.pullRequestUrl,
          hrefLabel: parsed.pullRequestUrl ? t("git.openPullRequest") : undefined,
        };
      }
    }
    return { text: t("git.pushOkGeneric") };
  }
  if (action === "fetch") return { text: t("git.fetchOk") };
  if (action === "pull") return { text: t("git.pullOk") };
  return { text: t("git.syncOk") };
}

export function gitSyncSuccessMessage(
  action: "fetch" | "pull" | "push",
  output: string,
  t: (
    key:
      | "git.syncOk"
      | "git.fetchOk"
      | "git.pullOk"
      | "git.pushOk"
      | "git.pushOkShort"
      | "git.pushOkNewBranch"
      | "git.pushOkGeneric"
      | "git.openPullRequest",
    vars?: Record<string, string>,
  ) => string,
) {
  return buildGitSyncFeedback(action, output, t).text;
}

const GIT_PATH_PATTERN = /[\w.-]+(?:\/[\w.-]+)+/g;

type GitErrorToastKey = "git.checkoutBlocked" | "git.checkoutBlockedHint" | "git.checkoutFailed" | "git.syncFailed";

function normalizeGitCliError(raw: string) {
  return raw
    .trim()
    .replace(/^(error|fatal):\s*/i, "")
    .replace(/\s*Aborting\.?\s*$/im, "")
    .trim();
}

function extractGitRepoPaths(raw: string) {
  return [...new Set(raw.match(GIT_PATH_PATTERN) ?? [])];
}

function isCheckoutBlockedError(message: string) {
  if (/would be overwritten by (checkout|merge)/i.test(message)) return true;
  if (/please commit your changes or stash/i.test(message)) return true;
  if (/commit your changes or stash them before you switch/i.test(message)) return true;
  if (/будут перезаписаны/i.test(message) && /checkout|переключ/i.test(message)) return true;
  if (/зафиксируйте.*изменен/i.test(message) && /stash/i.test(message)) return true;
  if (/локальные изменения/i.test(message) && /переключ/i.test(message)) return true;
  return false;
}

export function formatGitErrorToast(
  raw: string,
  t: (key: GitErrorToastKey, vars?: Record<string, string>) => string,
  options?: { context?: "checkout" | "sync" },
) {
  const message = normalizeGitCliError(raw);
  if (isCheckoutBlockedError(message) || isCheckoutBlockedError(raw)) {
    const files = extractGitRepoPaths(raw);
    if (files.length > 0) {
      return [t("git.checkoutBlocked"), ...files.map((file) => `• ${file}`), t("git.checkoutBlockedHint")].join(
        "\n",
      );
    }
    return `${t("git.checkoutBlocked")}\n\n${t("git.checkoutBlockedHint")}`;
  }

  if (options?.context === "checkout") return t("git.checkoutFailed");
  return t("git.syncFailed");
}
