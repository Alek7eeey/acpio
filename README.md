# Acpio

Self-hosted web harness for agents speaking [ACP](https://agentclientprotocol.com/) (Cursor CLI / OMP / OpenCode), with a built-in agent that runs inside the server — no external CLI needed.
Chat with streamed reasoning, tool calls and subagents, settings, META-style light/dark theme.

**Current version:** 0.1.39

> **AI disclaimer:** This project was developed in substantial part with the help of AI coding assistants. Review, test, and verify changes before relying on it in production.

## Stack

- `apps/web` — React + Vite + TypeScript
- `apps/server` — Fastify + WebSocket + ACP stdio bridge
- `packages/shared` — shared types
- SQLite (single file `data/acpio.db`, embedded via better-sqlite3)

## Quick start

**From npm (any OS, no build step)** — the fastest way:

```bash
npx acpio          # run without installing
npm i -g acpio     # global → `acpio`
```

Opens http://localhost:18741; `acpio --help` and `acpio --version` answer without
starting anything.

> **npm 12+** skips install-time scripts unless the package is allowed, and they
> are what builds the native modules — add
> `--allow-scripts=acpio,better-sqlite3,node-pty` to the commands above.

**One-click install (Windows)** — Node 20+ is required and installed
automatically on the first run:

```powershell
irm https://raw.githubusercontent.com/Alek7eeey/acpio/dev/scripts/setup.ps1 | iex
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

> The DB schema is created automatically at server boot (idempotent
> `ensureSchema`). Optional: `npm run db:push` to (re)generate it via drizzle-kit.
> `.env` is optional — all settings have working defaults (see "Production build").

> **After pulling code updates** (`git pull`) do a **hard refresh** in the browser
> (`Ctrl+Shift+R`). Browsers cache old CSS/JS modules, and without a hard refresh
> new changes may not show up.

- Prod: [http://localhost:18741](http://localhost:18741) — UI + API + WebSocket
- Dev: UI [http://localhost:18751](http://localhost:18751), API [http://localhost:18741](http://localhost:18741)
- DB file: `data/acpio.db` (override with `DATABASE_PATH` in `.env`); the npm
  CLI keeps it in a per-user directory (`%LOCALAPPDATA%\acpio\data`)

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

### Settings and mobile

Connect agents, tune models, open from a phone over VPN/LAN.

| Chat settings | Agents | Phone & VPN | Mobile |
|---|---|---|---|
| ![Settings](docs/screens/settings-en.webp) | ![Agents](docs/screens/settings-agents-en.webp) | ![Remote access](docs/screens/settings-remote-en.webp) | ![Mobile chat](docs/screens/mobile-chat-en.webp) |

Regenerate screenshots after UI changes: `npm run screens` (requires `npm run dev` and `npx playwright install chromium`). English shots (`*-en.webp`) use the English UI; Russian shots omit the `-en` suffix. Capture prefers conversations whose text matches that language.

## Production build

`npm run build` compiles everything; the server then serves the web UI itself,
so production is a **single port**:

```bash
npm run build
npm run start     # → http://localhost:18741 (UI + API + WebSocket)
```

### npm package

`npm run pack:npm` builds the publishable package into `dist-npm/`: the compiled
server, the web UI, the bundled workspace packages, `bin/acpio.mjs` (the CLI) and
the postinstall node-pty patch. Registry dependencies are left to the consumer's
install, so the artifact holds no platform-specific binary and any machine can
build it. Publish it with `npm publish ./dist-npm` — a release tag does that by
itself over npm trusted publishing (see "Releasing").

The installed CLI keeps its SQLite file in a per-user directory —
`%LOCALAPPDATA%\acpio\data`, `$XDG_DATA_HOME`/`~/.local/share/acpio/data` or
`~/Library/Application Support/acpio/data` — so `npm i -g acpio@latest` never
touches your chats (`DATABASE_PATH` overrides it; `PORT` / `ACPIO_PORT` / `HOST`
work as in the source build). npm 12 skips install-time scripts unless the
package is allowed, and those scripts build/download `better-sqlite3` and
`node-pty` and apply the ConPTY patch — hence
`npm i -g acpio --allow-scripts=acpio,better-sqlite3,node-pty`.

### Portable bundle (Windows)

```bash
npm run dist
```

produces `dist-app/acpio-win-x64.zip` — the compiled server, the web UI,
the workspace packages and production `node_modules` (native better-sqlite3
included). Unzip anywhere and run `start.cmd` (Node >= 20 required).

> The zip embeds the native better-sqlite3 binary, so build it on the OS/arch
> you distribute to (currently Windows x64).

### One-click install

Attach `dist-app/acpio-win-x64.zip` to a
[GitHub release](https://github.com/Alek7eeey/acpio/releases) named
`acpio-win-x64.zip`, then on a fresh Windows machine:

```powershell
irm https://raw.githubusercontent.com/Alek7eeey/acpio/dev/scripts/setup.ps1 | iex
```

The script checks/installs Node 20+, downloads the release bundle, unpacks it
to `%LOCALAPPDATA%\acpio` and starts the app (data goes to
`%LOCALAPPDATA%\acpio\data`). For a local bundle instead of a download:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -ZipPath .\dist-app\acpio-win-x64.zip
```

Production env vars: `PORT` (default 18741), `HOST` (default `0.0.0.0`),
`DATABASE_PATH` (default `<app dir>/data/acpio.db`).

### `ACPIO_TAKEOVER=1` — force claim a locked database (humans only)

One acpio per database file: a start against a locked database normally refuses
and names the holder's pid. Set `ACPIO_TAKEOVER=1` and that refusal is replaced
by kill-and-claim: the server verifies the holder really is an acpio process
(its command line must name this repo), kills the holder's **whole process
tree** (a watch parent would otherwise respawn it), waits for the lock to free,
then claims it. Useful as the start argument of a supervised command — after a
stray `npm run dev` or a stopped-and-restarted instance grabs `data/acpio.db`,
this start wins.

**Only a person may use this.** Agents and CI must never set it: it force-kills
whichever process holds the lock, and starting a second live server on one
database is precisely the corruption the lock exists to prevent. If an agent
hits `acpio is already running`, the correct answer is to report the holder's
pid, not to take over. Without the variable the old behavior stands: refuse.

## Phone and VPN

The dev server listens on all interfaces (`0.0.0.0`), so you can open the UI from a phone via the PC's IP on the same network or VPN. The production build works the same way on port **18741**.

1. Start `npm run dev` on the PC (or `npm run start` for the single-port prod build).
2. Connect the phone to the same VPN/LAN as the PC (WireGuard, Tailscale, etc.).
3. Find the PC's IP in the VPN/LAN (not `0.0.0.0` and not `localhost`) and open `http://PC_IP:18751` on the phone.
4. If needed, allow inbound TCP **18751** (and **18741**) in the Windows firewall.
5. In the UI: **Settings → Phone and VPN** — a short cheat sheet and a copy button for the current address. The **Install** button in the toolbar adds the site to the home screen.

`http://0.0.0.0:18751` won't work in a browser — it's only the server's listening address.

## Cursor / OMP

1. Install [Cursor CLI](https://cursor.com/docs/cli) and/or OMP.
2. Sign in: `agent login` (or set `CURSOR_API_KEY` in settings).
3. Check ACP: `agent acp` (the process should start and wait for JSON-RPC on stdin).
4. In the UI → **Settings** set command/args and the `default cwd`.
5. Create a chat and send a message.

- Cursor: command `agent`, args `acp`
- OMP: command `omp`, args `acp`

## Connecting an agent

1. In **Settings** pick a provider (Cursor / OMP).
2. Set the API key in the right field (if needed):
   - Cursor → `CURSOR_API_KEY`
3. Click **Test agent connection**.
4. Permission policy for local: `Always allow`.
5. Create a chat and send a message.

A harness you do not use can be switched off with the toggle on **Settings → Agents → Connection**:
it is no longer probed and disappears from agent pickers, model defaults and CLI fields.

If a chat seems stuck — press **Stop** and send again.

## Harness plugins

The core is harness-agnostic: Cursor and OMP are **adapter plugins** registered in
`apps/server/src/adapters/registry.ts`. A third-party harness is added as a
`packages/adapter-*` package implementing `HarnessAdapter` — the UI picks it up
automatically (provider list, CLI/API-key fields, models) from `GET /api/adapters`.

- Docs: [docs/usage.md](docs/usage.md) — how to use harnesses and plugins
- [docs/adapters.md](docs/adapters.md) — how to write a harness plugin

## Architecture

Browser ↔ REST/WS server ↔ registry-driven spawn of the harness CLI (`agent acp` / `omp acp`, JSON-RPC NDJSON) ↔ SQLite.

`session/update` events, permissions, questions, plans and subagent cards are rendered in the chat feed via normalized adapter events.

## Versioning

A release is a `v<major>.<minor>.<patch>` **git tag**, and the version a revision reports is derived from those tags (`scripts/releaseTags.mjs`):

- a tagged revision reports its own tag — the number it was published under;
- any other revision reports one patch above the highest tag reachable from it — the number it is about to be released as;
- before the first release, the base version from `package.json`.

Tags are part of git, so the same revision reports the same number on every machine, with no registry or network involved. The cadence is yours: a week of commits is still one bump, ten releases a day are ten numbers, and the published numbers follow in order because they follow the releases.

The number is written into `README.md`, `readme-ru.md`, `VERSIONS.md` (one row per release) and `packages/shared/src/buildInfo.ts` by `scripts/generate-version.mjs` — at build time and from the `pre-commit` hook (`scripts/stamp-version.mjs`, installed by `npm install` via `core.hooksPath=.githooks`; re-run with `npm run hooks:install`). The hook stages the files it changed, so a checkout that pulled after a release carries that bump into its next commit. `git commit --no-verify` skips the stamp for one commit.

### Releasing

A release is one tag, and it can be made either way round — from the terminal:

```bash
git tag v0.1.39 && git push origin v0.1.39
```

or from the UI: **Actions → release → Run workflow**, which publishes the version
the checkout derives, tags it and writes the GitHub Release. The manual run takes
two fields:

- `publish` (off by default) — off builds and checks the package, on publishes it
  and follows through with the tag and the release;
- `notes` — what changed: it becomes the GitHub Release body. Left empty, the body
  comes from the annotated tag (`git tag -a v0.1.39 -m "…"`) or, for a lightweight
  one, from the commits since the previous release.

Both doors end the same way: the package on npm (over trusted publishing, so no
token and no one-time password — the package's Settings → Trusted publishing
names this repo and `release.yml`) and a GitHub Release at `v<version>` that says
what changed.

A tag you push yourself must equal the version the release tags derive (one patch
above the highest one reachable) — the workflow packs with `--expect-tag` and
refuses otherwise, so what npm serves can never disagree with the number the app
itself reports. A run whose version is already on npm publishes nothing and
releases nothing, and the version only moves when a release happened — commit as
often as you like, the numbers stay in order.

## License

MIT — see [LICENSE](LICENSE).
