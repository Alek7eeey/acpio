# Acpio

Self-hosted web harness for agents speaking [ACP](https://agentclientprotocol.com/):
**Cursor CLI**, **OMP**, **OpenCode** — or the **built-in agent** that runs inside the
server, so a chat works without installing a CLI at all. Kanban **boards** drive tasks
across projects, each task being a chat of its own.
Chat with streamed reasoning, tool calls and subagents, settings, META-style light/dark theme.

**Current version:** 0.1.43

> **AI disclaimer:** This project was developed in substantial part with the help of AI coding assistants. Review, test, and verify changes before relying on it in production.

## Install from npm

The shortest path — no build step, any OS:

```bash
npx acpio          # run without installing
npm i -g acpio     # global → `acpio`
```

Opens http://localhost:18741; `acpio --help` and `acpio --version` answer without
starting anything.

> **npm 11.17+** skips install-time scripts unless the package is allowed, and they
> are what builds the native modules — add
> `--allow-scripts=acpio,better-sqlite3,node-pty` to the commands above.

### Other ways to install

**One-click (Windows)** — Node 20+ is required and installed automatically on the
first run:

```powershell
irm https://raw.githubusercontent.com/Alek7eeey/acpio/dev/scripts/setup.ps1 | iex
```

**From npm through PowerShell (Windows)** — the same Node 20+ bootstrap, then a global
`npm i -g acpio@latest` with the install scripts allowed, so the native modules are built
in one go and the `acpio` command starts the app later:

```powershell
irm https://raw.githubusercontent.com/Alek7eeey/acpio/dev/scripts/install.ps1 | iex
```

Save the script to pass `-Version 0.1.42` (pin a release) or `-NoLaunch` (install only):

```powershell
irm https://raw.githubusercontent.com/Alek7eeey/acpio/dev/scripts/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1 -NoLaunch
```

**From source (production, single port):**

```bash
npm install
npm run build
npm run start     # → http://localhost:18741 (UI + API + WebSocket)
```

**Development (hot reload):**

```bash
npm install
npm run dev       # UI http://localhost:18751, API http://localhost:18741
```

**Portable bundle (Windows):** `npm run dist` → `dist-app/acpio-win-x64.zip`, unpack
anywhere and run `start.cmd`. The zip embeds the native better-sqlite3, so build it
on the OS/arch you distribute to (currently Windows x64).

Notes:

- Prod: [http://localhost:18741](http://localhost:18741) — UI + API + WebSocket;
  dev: UI [http://localhost:18751](http://localhost:18751), API
  [http://localhost:18741](http://localhost:18741).
- The DB schema is created at server boot (idempotent `ensureSchema`); `.env` is
  optional — every setting has a working default.
- DB file: `data/acpio.db` (override with `DATABASE_PATH`); the npm CLI keeps it in a
  per-user directory (`%LOCALAPPDATA%\acpio\data`,
  `$XDG_DATA_HOME`/`~/.local/share/acpio/data`,
  `~/Library/Application Support/acpio/data`), so an update never touches your chats.
- After `git pull` do a **hard refresh** in the browser (`Ctrl+Shift+R`) — cached
  CSS/JS modules hide new changes.

## Screenshots

### Chat

Dark and light themes with streamed reasoning, tool calls, and subagent cards.

| Dark | Light |
|---|---|
| ![Chat dark](docs/screens/chat-dark-en.webp) | ![Chat light](docs/screens/chat-light-en.webp) |

### Slash commands, search, split view

Type `/` in the composer to browse agent commands (from ACP `available_commands`). Search across all messages in a chat. Split the workspace into two panes on desktop.

| Slash menu | Message search | Two chats |
|---|---|---|
| ![Slash commands](docs/screens/chat-slash-en.webp) | ![Search](docs/screens/chat-search-en.webp) | ![Split view](docs/screens/chat-split-en.webp) |

### Kanban board

A board is a workspace of its own: four lanes — **Todo**, **In Progress**, **Wait**,
**Done** — a rail of the folders it works in, and one chat per task.

![Kanban board](docs/screens/board-en.webp)

### Settings and mobile

Connect agents, tune models, open from a phone over VPN/LAN.

| Chat settings | Agents | Phone & VPN | Mobile |
|---|---|---|---|
| ![Settings](docs/screens/settings-en.webp) | ![Agents](docs/screens/settings-agents-en.webp) | ![Remote access](docs/screens/settings-remote-en.webp) | ![Mobile chat](docs/screens/mobile-chat-en.webp) |

Regenerate screenshots after UI changes: `npm run screens` (requires `npm run dev` and
`npx playwright install chromium`, or `SCREEN_BASE_URL=http://127.0.0.1:18741` against a
production build). English shots (`*-en.webp`) use the English UI; Russian shots omit the
`-en` suffix. Capture prefers conversations whose text matches that language.

## Harnesses

| Harness | Command | Args | What it needs |
|---|---|---|---|
| Cursor CLI | `agent` | `acp` | — |
| OMP | `omp` | `acp` | — |
| OpenCode | `opencode` | `acp` | — |
| Built-in agent | — | — | one OpenAI-compatible endpoint (URL + key) |
| Your own agent | any ACP CLI | — | **Settings → Agents → Connect → Custom agents** |

1. In **Settings → Agents → Connect** press **Test** — the server spawns the ACP process
   and shows its models.
2. Command, args and API key can be overridden in **Settings → Agents → Advanced → CLI &
   permissions**; permission policy for local work: `Always allow`.
3. Press **Connect**, then create a chat.

A harness you do not use can be switched off with the toggle in **Settings → Agents →
Connection**: it is no longer probed and disappears from agent pickers, model defaults and
CLI fields. If a chat seems stuck — press **Stop** and send again.

- **Built-in agent** — an agent that runs inside the server: nothing to `npm i -g`, no
  separate login. **Settings → Built-in agent** holds one or more
  OpenAI-compatible endpoints and the models ticked for the agent; **Agent presets** cut
  the same agent into profiles of their own (a fast one, one with room to reason) that
  join the agent picker like any other harness. Tools: `read`, `glob`, `grep`, `write`,
  `edit`, `bash`, `ask`, `plan` and the MCP servers from **Settings → MCP**.
- **Own ACP agents** — **Settings → Agents → Connect → Custom agents**: point at an
  executable and its arguments, and it behaves like a bundled harness.

Docs: [docs/usage.md](docs/usage.md) — harnesses, boards and plugins ·
[docs/adapters.md](docs/adapters.md) — writing a harness plugin.
The core is harness-agnostic: a harness is a `packages/adapter-*` plugin registered in
`apps/server/src/adapters/registry.ts`, and the UI builds its provider list, CLI fields and
models from `GET /api/adapters`.

## Boards

Create a board from the **Board** tab of the new-chat picker or with **New board** in the
chat tree; rename it in the pill above the lanes, and add its projects with **Board
folders**. **+** on a group starts a task in that folder — the form's agent and **Start
immediately** switch decide who runs it and when, and files can be attached to the first
turn. A card's lane follows the session: a task never started sits in **Todo**, a live turn
in **In Progress**, and a finished turn, a waiting question or a failed turn in **Wait**,
where **Mark done** / **Reopen** move it by hand. Board tasks stay out of the chat tree, and
deleting a board deletes its tasks. Details: [docs/usage.md](docs/usage.md#kanban-boards).

## Phone and VPN

The server listens on all interfaces (`0.0.0.0`), so the UI opens from a phone over the same
VPN/LAN: start acpio, open `http://PC_IP:18741` (dev: `:18751`) on the phone, and allow
inbound TCP **18741** (and **18751**) in the firewall if needed. **Settings → Phone and VPN**
shows a cheat sheet with a copy button; **Install** in the toolbar adds the site to the home
screen. `http://0.0.0.0:18741` is the listening address, not a browser address.

## Tests

```bash
npm test                 # unit, server integration, jsdom components (vitest)
npm run test:e2e         # the built app in a real browser (Playwright)
```

The end-to-end suite drives the production bundle, not the dev servers: it starts the built
server on its own database (`tmp/e2e`, wiped per run), registers the deterministic fake ACP
agent from `apps/server/test/fake-agent.mjs`, and runs the same specs on a desktop layout
(1440×900) and two phones (Pixel 7, iPhone SE). Each spec gets its own chat and the app's
global settings are put back before the next one.

### Which command runs which tests

The first time, build the app and install the browser:

```bash
npm run build && npx playwright install chromium
```

After that, pick a command — every one of them needs no other setup:

| Command | What it runs | Tests | Time |
|---|---|---|---|
| `npm run test:e2e` | everything: desktop + Pixel 7 + iPhone SE | 20 | ~1.5 min |
| `npm run test:e2e:desktop` | only the desktop layout, 1440×900 | 10 | ~35 s |
| `npm run test:e2e:mobile` | only the phones: Pixel 7 and iPhone SE | 10 | ~30 s |

`desktop.spec.ts` belongs to the `desktop` project only, `mobile.spec.ts` to the two phone
projects (`mobile` = Pixel 7, `mobile-small` = iPhone SE) — which is why its five tests count
twice in the full run. A single test or a group: add `-- -g "phone chat"` to any of them.

The suite's own helpers live in `e2e/support/`: `server.mjs` is the app under test (the built
server on its own database, :18761 — `node e2e/support/server.mjs` runs it by hand), `seed.mjs`
houses the fake agent and the settings every test starts from, `app.ts` the fixtures the specs
share, and `manifest-reporter.mjs` the index the screenshots slideshow reads.

### Watching a run

A green line in the log is not proof that a screen looks right. Three ways to look at the same
suite — the first is live, the other two are after the fact. Run them one at a time: two runs
at once share `tmp/e2e/artifacts` and one database, so they fail each other.

| What you want | Command | Where it opens |
|---|---|---|
| run tests by hand, watch every step | `npm run test:e2e:ui` | its own Playwright window (random port; `--ui-port 9333` pins it) |
| one page per test, with traces | `npm run test:e2e:report` | http://localhost:9323 (after a run) |
| all screenshots in a row | `npm run test:e2e:gallery` | http://127.0.0.1:9324/gallery/ (`--port` moves it) |

Both servers live exactly as long as the command that started them (Ctrl+C — the address stops
answering); the files under `tmp/e2e` outlive them until the next run. The report is written by
the run itself, the gallery reads `tmp/e2e/manifest.json`, which the run writes too — so both
always show the *last* run, and both need the run to happen first.

**Variant 1 — run the tests by hand (UI mode)**

```bash
npm run test:e2e:ui
```

A Playwright window opens by itself — there is no URL to open and nothing to remember. In it:

1. the tests are on the left; the `Projects:` chip in the top bar decides which layouts are
   listed (`desktop`, `mobile`, `mobile-small`);
2. ▶ next to a test or a group (`desktop shell`, `phone chat`…) runs that one; ▶ at the top of
   the list runs everything the current filter shows;
3. after the run, click any action in the timeline: each keeps its own screenshot and a DOM
   snapshot, so a missed click on a phone layout is visible instead of guessed at;
4. the tabs below (Console, Network, Source, Errors) are that moment of the page;
5. the eye icon is watch mode: edit the code and the test runs again by itself.

This run leaves nothing to reopen — close the window and it is gone.

**Variant 2 — run it, then read the report**

```bash
npm run test:e2e          # the whole suite: desktop + Pixel 7 + iPhone SE, ~1.5 min
npm run test:e2e:report   # serves tmp/e2e/report on http://localhost:9323
```

The console gives one line per test and the total:

```
  ok  1 [desktop] › desktop.spec.ts:20:3 › desktop shell › boots the chat view … (3.0s)
  …
  20 passed (1.1m)
```

The report has a row per test; `View Trace` under a row replays its steps with the same
screenshots and console — after the fact, and for every test at once. Locally every test,
green ones included, keeps a screenshot and a full trace; CI keeps only failures.
`npx playwright show-trace tmp/e2e/artifacts/<test>/trace.zip` opens a single trace on its own.

**Or all the screenshots at once**

```bash
npm run test:e2e:gallery   # http://127.0.0.1:9324/gallery/
```

The report shows one test per page; this shows the same run as a strip of screenshots — one
frame per test, in run order, captioned with its project, group and title. ← / → to step,
Space to autoplay, the chips on top to keep one layout. It reads `tmp/e2e/manifest.json`,
written by the run itself (`e2e/support/manifest-reporter.mjs`), so it always shows the last
one — start it again after a new run. `-- --port 9400` moves the port, `-- --no-serve` only
writes the page.

Order matters: the run *writes* `tmp/e2e/report`, `test:e2e:report` only *serves* it. A new run
wipes the folder under an open tab and it starts answering 404 — so run first, open second, and
repeat the serve command after every new run. `test:e2e:desktop` / `test:e2e:mobile` are the
same suite narrowed to one layout.

CI runs it after `npm test` in the same `ci` job, so a broken shell or a broken phone layout
fails the required check; a failing run uploads its traces and screenshots as an artifact.

## Architecture

Browser ↔ REST/WS server ↔ registry-driven spawn of the harness CLI (`agent acp` / `omp acp`
/ `opencode acp`, JSON-RPC NDJSON) or the in-process built-in agent ↔ SQLite.

`session/update` events, permissions, questions, plans and subagent cards are rendered in the
chat feed via normalized adapter events.

## Versioning

A release is cut once a batch of changes has accumulated. Each release is a
`v<major>.<minor>.<patch>` git tag, and the same number is published to npm. `VERSIONS.md`
lists the releases, newest first.

### `ACPIO_TAKEOVER=1` — force claim a locked database (humans only)

One acpio per database file: a start against a locked database refuses and names the holder's
pid. `ACPIO_TAKEOVER=1` replaces that refusal with kill-and-claim — verify the holder really
is an acpio process, kill its whole process tree, then claim the lock.

**Only a person may use this.** Agents and CI must never set it: it force-kills whoever holds
the lock, and two live servers on one database is exactly the corruption the lock prevents.
Without the variable the old behavior stands: refuse.

## License

MIT — see [LICENSE](LICENSE).
