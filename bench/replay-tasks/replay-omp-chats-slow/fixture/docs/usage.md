# Using Harnesses and Plugins

Acpio connects agents through **harness adapters**. Three are bundled: **Cursor**,
**OMP** (external CLIs) and the **built-in agent** that runs inside the server itself.
Any other harness is added as a plugin adapter (see the
[developer guide](adapters.md)) and shows up in the UI automatically — the core needs no changes.

## Chat interface

The main workspace shows a **session tree** on the left and the active chat on the right.

- **Reasoning** — agent thoughts stream in collapsible blocks (when the harness exposes them). An expanded block keeps a round icon button floating at its bottom-right, so a long transcript can be collapsed from where you are reading instead of scrolling back to its header. Collapsing keeps your place: if the reply after the block was on screen it stays where it is, and if you were inside a long block the view lands on the collapsed block instead.
- **Tool calls** — each tool invocation appears as a card with arguments and output.
- **Subagents** — `task` requests show progress, roster, and nested thinking when available.
- **Permissions & questions** — inline prompts when the agent needs approval or user input. When the agent asks a question the chat is *parked on you*: the question stays answerable no matter how long you take, and it survives restarting the app or the server — opening the chat again shows the same question, and answering it resumes the turn on a fresh agent process (the answer is sent to the agent as a message, since the original request no longer exists). **Stop** ends the question along with the turn.
- **Composer** — attach files, pick model/mode per chat, stop a running turn with **Stop**. The attach button takes files from the browser's own device by default — they are uploaded into the session folder so the agent can read them. A right-click opens the filesystem of the machine running the server instead; which source a plain click uses is set by **Attach button opens** in **Settings → Chat**. Chips above the input collapse into **More** when they would clip; each chip (folder, branch, changes) can be told to shrink instead, in **Settings → Chat**.
- **Reloading the page** — the browser asks "are you sure?" only when this tab holds something the server has never seen: text typed into the composer (in any chat, including the second pane) and files attached but not yet sent. A running turn, a queue the server is already draining and a parked question all live on the server and survive a reload, so warning about them would be noise.
- **Line wrap in code and diffs** — every code block carries a wrap button next to **Copy**: on, long lines fold to the block width; off, the block scrolls sideways. The same switch sits in the diff toolbar of the changes panel. One setting covers every block and is remembered per browser, so toggling it anywhere applies everywhere. On a touch screen the gesture is taken by one of the two: one that sets off up or down scrolls the list and leaves the long lines where they are, one that sets off sideways scrolls those lines and leaves the list where it is. In **Two columns** the wrap switch is disabled — those columns are sized for the whole file, so lines always wrap there.
- **Plan, git, terminal** — dock beside the chat when there is room. If only a sliver of chat would remain (or the window is already narrow), the tab takes the full chat area until you close it. On a phone the tab takes the whole screen: the header and the chats dock step aside, and the back chevron in its own bar returns to the chat. The plan never opens by itself on those narrow layouts: a new or updated plan only lights the plan chip above the composer (an approval also drops its card into the thread), so the chat stays where you left it.
- **Changed files** — the changes tab is a diff board with a navigator next to it: the diff keeps the left, while the navigator on the right holds the **Changes** / **History** tabs, the file list and the commit box. Narrow the panel below a diff-and-list split and the navigator folds into a bottom sheet, so the diff keeps the full width and picking a file closes the sheet at once. The list shows files flat or as a folder tree (switch above it, remembered per browser). Right-click a file for stage/discard/delete plus **Add to .gitignore**; right-click a folder in tree view to ignore, discard changes in, or delete the whole directory — folder entries stay one row each no matter how many files they hold. Entries are appended to the repository root `.gitignore` as `/path/` patterns, and already-listed paths are left alone.
- **Commit history** — **History** in the navigator pairs the log and its graph with the commit detail: pick a commit for its message, its files and their diff, or **// WIP** for the uncommitted state. Revert, cherry-pick, tag, branch and checkout are in each commit's ⋯ menu.
- **Diff board** — every changed file stacks top-to-bottom on the board; each one's diff is fetched as you scroll (the board opens at once instead of after reading every change), and only the blocks near the viewport stay mounted. The bottom bar carries the file counter, **Previous / Next file** and a picker that scrolls to the file you choose — below the split that picker *is* the navigator sheet. The expand button in the board header gives the diff the whole panel instead: the navigator steps aside (sheet included) and the board keeps its own picker, so a long diff can be read without the surrounding chrome; the same button, or Escape, brings the board back. With wrapping off, long lines scroll sideways **inside their own file**: the list never travels horizontally, so the sticky file headers stay put and every file keeps its own horizontal position. **List** / **Two columns** in the board header switch the diff layout. While an agent keeps writing files, the board stays on the file you are reading.

- **Session tree** — chats are grouped by working folder. Drag a folder header with the mouse (or its grip handle on a touch screen) to reorder the groups, or use **Move up / Move down** in the folder's ⋯ menu; the order is saved on the server, so every device sees it. **Settings → Chat → Chats per folder** caps how many of the newest chats each folder shows — the rest wait behind **Show more** (0 shows everything; the active chat is never hidden). On a phone the tree opens scrolled to the chat you are currently in instead of the top of the list.

Empty chats titled “New chat” / “Новый чат” follow the **Settings → Chat** interface language in the tree and header. Custom titles stay as you typed them.

### Slash commands

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
composer and scroll position. Only the pane you are working in scrolls: the wheel over the
other one does nothing until you click into it, so a reply streaming on the left stays put
while you read on the right.

### Per-chat MCP

MCP servers are configured globally in **Settings → MCP** (HTTP local/remote or **stdio**
command + args), but each chat shows which servers are active for that session in the header
chip. Changing the MCP list restarts the live agent process for affected chats (MCP is applied
only at `session/new|resume|load`). ACP requires an **absolute** stdio `command`, so a bare
name (`npx`, `mcp-gitea`) is resolved to its full path before the session starts; the server
console logs `stdio "<name>": <command> -> <path>`. If it cannot be resolved, put the binary's
full path in Settings → MCP.

### Per-folder MCP

**MCP servers** in a folder's context menu in the chat tree overrides the global list for that
folder: switch individual servers on or off — a server that is off globally included, so the
global list stays the only place a server is defined — and add servers that exist only for
chats opened there. A globally off server is still listed in the folder dialog (marked *off
globally*) and can be switched on for that one folder. Chats resolve their list as
*app-configured servers with the folder's switches applied + folder-only + servers from the
folder's MCP files − chat-disabled*, so the per-chat picker (the MCP chip in the composer)
still applies on top. Only the live chats whose effective list actually changed are restarted.
Deleting a folder deletes its override with it.

### Folder MCP files

Chats in a folder also pick up the MCP servers that folder already declares for other tools:
**Settings → MCP → Folder MCP files** lists the files read from each chat's own folder,
relative to it — by default `.omp/mcp.json`, `.cursor/mcp.json` and `.agents/mcp.json`, one
path per line. The first file in the list that declares a name owns it, and a name already
used by a server configured in the app keeps the app's configuration — whether that server is
switched on or off globally. `${VAR}` and
`${VAR:-default}` placeholders in `command`, `args`, `env`, `url` and `headers` are expanded
from the server's environment before the session starts (unresolved ones stay literal). An
`sse` URL is sent as HTTP, and an entry with neither `command` nor `url`, a file that is not
valid JSON, or a missing `mcpServers` object shows up as a warning in the folder's **MCP
servers** dialog instead of breaking the chat. Discovered servers appear there under **From
folder files** and can be switched on or off for that folder (and per chat), exactly like
app-configured ones; clearing the path list ignores folder files entirely. Server-side
executables still need an absolute `command` — a bare `npx` is resolved the same way as for
app-configured stdio servers. Editing a folder file applies the next time the folder's chats
start their agent (a model/MCP settings change, a server restart, or **Settings → Agents →
Reset agents**), since MCP is only handed to the agent at `session/new|resume|load`.

### Resume agent context

**Settings → Resume agent context** controls whether reopening a chat or restarting after
model/MCP changes brings back the agent's ACP session (`resume` / `load`) instead of
starting blank. Locale changes do not restart the agent — only UI and prompt hints update.

## Kanban boards

A **board** is a workspace of its own, for driving work across several projects at once.
Create one from the **Board** tab of the new-chat picker or with **New board** in the chat
tree; the tree lists boards under the chats, and opening one keeps the tree beside it. The
board page shows four columns — **Todo**, **In Progress**, **Wait**, **Done** — and a rail of
the folders the board works in.

The board's name sits in the top bar above, in the pill a chat's title would carry — one bar
for the whole view instead of a second title row of its own. A board's folders are its
projects: **Board folders** in that bar adds and removes them, and the rail lists each one
with its task count. Clicking a folder filters the whole board down to it, **All projects**
clears the filter, and the **+** on a rail row starts a task in that folder. **Todo** groups
its cards by project, and both the groups and the cards inside them move up and down — the
order is saved on the server, so it survives a reload.

Every task is a chat session of its own. **+** on a group writes a card carrying the project
chip; **right-clicking** that **+** (on a group or a rail row) opens the standard new-chat picker
with the folder locked, and confirming it creates the task empty — no description form — then
opens its chat, so the first message is what names and forms it. That is the shape a chat has
when it comes from the folder tree, and the fresh card rests in **Todo** until that turn runs.
The **Start immediately** switch in the creation form starts the task the moment it is
created — the default agent gets the description as the first message while you stay on the
board. The play icon on the card starts work right away too: the description goes out as the
first message, the card leaves **Todo**, and the chat does not open. Right-clicking the play
icon opens the agent picker with the same **Start immediately** switch: on, the task starts at
once with the agent you pick; off, the chat opens with the description already in the composer,
so pressing Enter (or picking a slash command) starts the turn. Both **Start immediately**
switches remember their state across page reloads. Clicking the card itself just
opens the chat: a never-started task gets its description in the composer, a started one leaves
it empty — the description was already sent. A card's column follows the session instead of a
stored status: a task whose first turn never ran sits in **Todo**, a live turn shows in **In
Progress**, and a finished turn, a question waiting for you or a failed turn lands in
**Wait** — where the card carries **Mark done** for work you call finished. **Done** outranks
a live turn, and **Reopen** sends the task back to **Todo**. Board tasks never show up in the
chat tree, and deleting a board deletes its tasks with it.

A chat opened from the board stays tied to it: the header carries a **‹ board name** pill next
to the brand, and one click on it is back to the board (on phones the pill takes the brand's
place). The context row above the input carries the same trip as a **Board** chip next to the
folder chip — right under the thumb while you type — and **Settings → Interface → Chat →
Advanced** turns it off or moves it. The way back keeps the reading position: the lanes and the
folder rail open where you left them, and the card you left through stays in view. The tree
lights up the board the task belongs to as well, so its row is another way back — the task
itself never appears there.

## Built-in agent (no install)

The **builtin** provider needs no CLI: its agent runs inside the server process, so there is
nothing to `npm i -g` and no separate login — the only requirement is an OpenAI-compatible
endpoint it can reach.

- **Settings → Agents → Built-in agent** — the providers: add as many OpenAI-compatible
  endpoints as you like (name + URL + API key), each with its own models. The model editor
  per provider pulls that endpoint's `GET /models` list, so you tick the models the agent
  may use, rename one or set its context window, search a long catalog, and add by hand
  whatever the API does not advertise. A model's context window comes from the endpoint
  when `/models` reports one, otherwise it is looked up in the public
  [models.dev](https://models.dev) registry by that endpoint's base URL and model id
  (an offline server keeps the assumed 128k); a window you type yourself is an override
  that later refreshes do not replace. Only ticked models are offered in pickers; the agent
  picks the change up on save, and every model runs on the provider that owns it.
- Tools: `read`, `glob`, `grep`, `write`, `edit` and `bash`. `glob`/`grep` search the
  workspace directly (no shelling out to `find`/`grep`), `edit` takes every replacement of
  a file as one batched call and refuses an ambiguous or overlapping anchor instead of
  guessing, writes land through the same three-way merge the other harnesses use, and
  `bash` runs on the host. Every mutating call asks for permission through the chat's
  permission card. Plan and Ask modes get `read`, `glob` and `grep` only — plus the
  read-only MCP tools — so a "look, don't touch" chat cannot edit anything.
- **Settings → MCP** servers attach to the session and are exposed as `mcp__<server>_<tool>`
  tools (stdio commands and streamable HTTP, including `insecureTls` endpoints); a server
  that fails to start is reported in the server log and the chat keeps its other tools.
- Long chats stay coherent: past ~80% of the model's context window the oldest turns are
  replaced by a model-written digest of the task so far, and the recent turns stay verbatim
  — the stored conversation itself is never trimmed.
- **Attached images reach the model itself.** A raster image you attach (PNG, JPEG, GIF,
  WebP, BMP, AVIF — up to 8 MB) is sent as an inline image part alongside your text, so a
  screenshot works on any vision-capable model the endpoint serves; anything else stays a
  path hint that the agent opens with `read`. The session file keeps the newest turn's
  images; older ones stay in the running conversation but are stored as a placeholder
  rather than growing the file by megabytes per screenshot.
- Sessions restore from Acpio's own history rather than an agent-side session file, so a
  server restart keeps the conversation without a resume call.

It appears in the agent picker like any other provider once an endpoint is
configured (without one the probe reports it offline), and can be made the default under
**Settings → Agents → Connect → Default agent**.

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
- **A chat "thinks" forever with nothing but `Internal error`** — the agent rejected the
  chat's working directory. OMP refuses `session/new` for a drive-relative path (`C:` instead
  of `C:/`); folder paths are stored in one canonical form (forward slashes, no trailing
  separator, but a drive root stays a root), and rows from older versions are repaired when
  the server starts.
- **After `git pull`** — hard-refresh the browser (`Ctrl+Shift+R`): old CSS/JS modules are cached.

## Mobile and remote access

- **Phone & VPN** — dev listens on `0.0.0.0`; open `http://<PC_IP>:18751` from a phone on the same LAN/VPN. Production uses port **18741**.
- **Install (PWA)** — toolbar button adds the app to the home screen.
- **Remote access key** — generated automatically in **Settings → Phone & VPN**. Required from a phone or another PC; localhost never asks. Delete it only if you want the LAN open.

See also the screenshots gallery in [README.md](../README.md).
