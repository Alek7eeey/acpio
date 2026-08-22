# Using Harnesses and Plugins

ACProcess connects agents through **harness adapters**. Two are bundled: **Cursor** and
**OMP**. Any other harness is added as a plugin adapter (see the
[developer guide](adapters.md)) and shows up in the UI automatically — the core needs no changes.

## Chat interface

The main workspace shows a **session tree** on the left and the active chat on the right.

- **Reasoning** — agent thoughts stream in collapsible blocks (when the harness exposes them).
- **Tool calls** — each tool invocation appears as a card with arguments and output.
- **Subagents** — `task` requests show progress, roster, and nested thinking when available.
- **Permissions & questions** — inline prompts when the agent needs approval or user input.
- **Composer** — attach files, pick model/mode per chat, stop a running turn with **Stop**.

### Slash commands

Type `/` in the composer to open the command menu. Commands come from the agent over ACP
(`available_commands`) and are merged per session — including OMP `skill:*` entries.
Pick a command to insert it; some commands show an input hint for extra arguments.
Slash commands are sent to the agent as prompts, not handled locally by the UI.

### Message search

Use **Search messages** in the chat toolbar to find text across the current session's
history. Results jump to the matching message in the feed.

### Split view (desktop)

Enable **Settings → Two chats side by side**, then use the split button under the header.
`Ctrl+click` a chat in the tree to open it in the other pane. Each pane has its own
composer and scroll position.

### Per-chat MCP

MCP servers are configured globally in **Settings → MCP**, but each chat shows which
servers are active for that session in the header chip. Changing the MCP list restarts
the live agent process for affected chats (MCP is applied only at `session/new|resume|load`).

### Resume agent context

**Settings → Resume agent context** controls whether reopening a chat or restarting after
model/MCP changes brings back the agent's ACP session (`resume` / `load`) instead of
starting blank. Locale changes do not restart the agent — only UI and prompt hints update.

## Connecting an agent (Cursor / OMP)

1. **Settings → Agents → Connect**.
2. Pick a provider (Cursor or OMP) and press **Test** — the server spawns the ACP process
   and shows the current model and its parameters.
3. If the CLI is not found, the hint text tells you how to install it. Alternatively, set the
   full path in **Settings → Agents → Advanced → "CLI & permissions"** — command, args, and
   API key (when the adapter declares one).
4. Press **Connect**.
5. Create a chat and send a message.

Defaults:

| Provider | Command | Args | API key |
|---|---|---|---|
| Cursor | `agent` | `acp` | `CURSOR_API_KEY` |
| OMP | `omp` | `acp` | — |

> Cursor IDE ≠ Cursor CLI. Install the CLI separately and run `agent login`.

## How the plugin registry works

- The server serves all registered adapters via `GET /api/adapters`; the web builds the
  provider list, descriptions, and the "CLI & permissions" fields from that metadata.
- The provider is stored in sessions and settings (`connectedProvider` / `defaultProvider`)
  as the adapter's string id (`cursor`, `omp`, …).
- On session restore/restart the adapter decides how to bring back the agent context:
  `resume` (silent, no replay), `load` (with history replay), or `new` (blank). That behavior
  lives in the adapter, not in the core.

## Adding a third-party harness

1. Implement `HarnessAdapter` in a `packages/adapter-*` package (model it on
   `adapter-cursor` / `adapter-omp`).
2. Register it in `apps/server/src/adapters/registry.ts` (one import + one array entry).
3. `npm install`, restart the server.
4. Add the description i18n key to `ru.json` / `en.json`.

The adapter then appears on its own:

- **Settings → Agents → Connect** — provider card with its description;
- **Settings → Agents → Advanced → "CLI & permissions"** — command, args and API-key fields
  declared by the adapter;
- **Settings → Agents → Model** — model list and parameters (fast/effort/…) when the adapter
  supports them;
- the sidebar and header — the provider label.

## What a plugin can do

- **Own command/args/key** — settings fields declared by the adapter.
- **Session restore** — `resume` / `load` / `new`.
- **Models and parameters** — catalog from ACP options, a cloud catalog via `models --json`,
  or a custom `probeModels`.
- **Subagents** — cards from `task` requests, rosters and progress; subagent thinking
  streaming when the harness exposes it.
- **Todo lists, questions, plans, image generation** — through normalized events.

## Troubleshooting

- **"Unknown agent …"** — the provider id is not registered (typo, or the adapter is missing
  from `registry.ts`).
- **"Command not found"** — the CLI is not installed or not in PATH; the hint text comes from
  the adapter and includes install steps.
- **Model does not apply** — check that the value is in the agent's model list; Cursor accepts
  only the listed `model[param=value]` combinations.
- **After `git pull`** — hard-refresh the browser (`Ctrl+Shift+R`): old CSS/JS modules are cached.

## Mobile and remote access

- **Phone & VPN** — dev listens on `0.0.0.0`; open `http://<PC_IP>:5173` from a phone on the same LAN/VPN. Production uses port **3001**.
- **Install (PWA)** — toolbar button adds the app to the home screen.
- **Remote access key** — optional key in **Settings → Phone & VPN** to protect the instance when exposed beyond localhost.

See also the screenshots gallery in [README.md](../README.md).
