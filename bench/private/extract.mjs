#!/usr/bin/env node
// Scaffold a private-eval task from a real commit of this repo:
//
//   node bench/private/extract.mjs <commit-ish> <task-id>
//
// Writes bench/private/tasks/<task-id>/ with NOTES.md (commit message, touched
// files, de-identification checklist) and a task.json skeleton. The fixture,
// the hidden verifier and the solution are the curator's job — see README.md.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [rev, taskId] = process.argv.slice(2);
if (!rev || !taskId || !/^[a-z0-9-]+$/.test(taskId)) {
  console.error("usage: node bench/private/extract.mjs <commit-ish> <task-id>");
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { cwd: REPO, encoding: "utf8" }).trim();
const subject = run(`git log -1 --format=%s ${rev}`);
const body = run(`git log -1 --format=%b ${rev}`);
const stat = run(`git show --stat --format= ${rev}`);
const short = run(`git rev-parse --short ${rev}`);

const dir = path.join(REPO, "bench", "private", "tasks", taskId);
if (existsSync(dir)) {
  console.error(`refusing to overwrite existing task dir: ${dir}`);
  process.exit(1);
}
mkdirSync(path.join(dir, "fixture"), { recursive: true });

writeFileSync(
  path.join(dir, "NOTES.md"),
  [
    `# ${taskId} — из коммита ${short}`,
    "",
    "## Тема",
    "",
    subject,
    "",
    "## Тело",
    "",
    body || "(пусто)",
    "",
    "## Что трогалось",
    "",
    "```",
    stat,
    "```",
    "",
    "## Чеклист куратора",
    "",
    "- [ ] Сформулировать промпт как запрос от человека, а не как отчёт автора фикса",
    "- [ ] Синтетическая репродукция механики сбоя в fixture/ (не снапшот кода)",
    "- [ ] Деидентификация: без внутренних URL, имён сервисов и заказчиков",
    "- [ ] Скрытый verify.mjs — поведенческий, детерминированный, < 60 с",
    "- [ ] solution/ — полный слепок исправленного fixture",
    "- [ ] `node bench/selftest.mjs --only " + taskId + "` — баг падает, gold проходит",
    "",
  ].join("\n"),
);

writeFileSync(
  path.join(dir, "task.json"),
  JSON.stringify(
    {
      id: taskId,
      title: subject.length > 80 ? subject.slice(0, 77) + "..." : subject,
      prompt: "TODO: сформулировать по NOTES.md (как запрос человека, без спойлеров фикса)",
      timeoutMs: 240000,
      difficulty: "medium",
      horizon: "s",
      family: "private",
    },
    null,
    2,
  ) + "\n",
);

console.log(`scaffolded bench/private/tasks/${taskId}`);
console.log(`next: fill NOTES.md checklist, then node bench/selftest.mjs --only ${taskId}`);
