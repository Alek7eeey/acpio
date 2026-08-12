# ACProcess

Self-hosted web harness for agents speaking [ACP](https://agentclientprotocol.com/) (Cursor CLI / OpenCode / OMP / PI).
Chat with streamed reasoning, tool calls and subagents, settings, META-style light/dark theme, Gitea wrapper.

## Stack

- `apps/web` — React + Vite + TypeScript
- `apps/server` — Fastify + WebSocket + ACP stdio bridge
- `packages/shared` — shared types
- PostgreSQL (Docker)

## Quick start

```bash
# 1. Postgres (host port 5433, so it doesn't clash with a local PG)
docker compose up -d

# 2. Env
copy .env.example .env   # Windows
# cp .env.example .env   # macOS/Linux

# 3. Install
npm install

# 4. DB schema
npm run db:push

# 5. Dev
npm run dev
```

> **После обновления кода** (`git pull`) сделай **hard refresh** в браузере (`Ctrl+Shift+R`).
> Браузер кеширует старые CSS/JS модули, и без hard refresh новые правки могут не примениться.

- Web: [http://localhost:5173](http://localhost:5173)
- API: [http://localhost:3001](http://localhost:3001)
- Postgres: `localhost:5433`

## Phone and VPN

The dev server listens on all interfaces (`0.0.0.0`), so you can open the UI from a phone via the PC's IP on the same network or VPN.

1. Start `npm run dev` on the PC.
2. Connect the phone to the same VPN/LAN as the PC (WireGuard, Tailscale, etc.).
3. Find the PC's IP in the VPN/LAN (not `0.0.0.0` and not `localhost`) and open `http://PC_IP:5173` on the phone.
4. If needed, allow inbound TCP **5173** (and **3001**) in the Windows firewall.
5. In the UI: **Settings → Phone and VPN** — a short cheat sheet and a copy button for the current address. The **Install** button in the toolbar adds the site to the home screen.

`http://0.0.0.0:5173` won't work in a browser — it's only the server's listening address.

## Cursor / OpenCode / OMP / PI

1. Install [Cursor CLI](https://cursor.com/docs/cli), OpenCode, OMP and/or PI (`pi` + `npm i -g pi-acp`).
2. Sign in: `agent login` (or set `CURSOR_API_KEY` in settings).
3. Check ACP: `agent acp` (the process should start and wait for JSON-RPC on stdin).
4. In the UI → **Settings** set command/args and the `default cwd`.
5. Create a chat and send a message.

- OpenCode: `opencode auth login`, command `opencode`, args `acp`
- OMP: command `omp`, args `acp`
- PI: command `pi-acp`, args empty (the `pi` CLI is also required)

## Connecting an agent

1. In **Settings** pick a provider (OpenCode / Cursor / OMP / PI).
2. Set the API key in the right field (if needed):
   - OpenCode → `OPENCODE_API_KEY` (+ optionally Anthropic/OpenAI)
   - Cursor → `CURSOR_API_KEY`
3. Click **Test agent connection**.
4. Permission policy for local: `Always allow`.
5. Create a chat and send a message.

If a chat seems stuck — press **Stop** and send again.

## Architecture

Browser ↔ REST/WS server ↔ spawn `agent acp` / `opencode acp` / `omp acp` / `pi-acp` (JSON-RPC NDJSON) ↔ Postgres.

`session/update` events, permissions, `cursor/ask_question`, `cursor/create_plan`, `cursor/task` are rendered in the chat feed.
