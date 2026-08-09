# ACProcess

Self-hosted веб-харнесс для агентов по [ACP](https://agentclientprotocol.com/) (Cursor CLI / OpenCode / OMP / PI).  
Чат со стримом рассуждений, tool calls и субагентов, настройки, светлая/тёмная тема в стиле META, обёртка Gitea.

## Стек

- `apps/web` — React + Vite + TypeScript
- `apps/server` — Fastify + WebSocket + ACP stdio bridge
- `packages/shared` — общие типы
- PostgreSQL (Docker)

## Быстрый старт

```bash
# 1. Postgres (порт хоста 5433, чтобы не конфликтовать с локальным PG)
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

- Web: [http://localhost:5173](http://localhost:5173)  
- API: [http://localhost:3001](http://localhost:3001)  
- Postgres: `localhost:5433`

## Телефон и VPN

Dev-сервер слушает все интерфейсы (`0.0.0.0`), поэтому с телефона можно открыть UI по IP компьютера в той же сети или VPN.

1. На ПК запустите `npm run dev`.
2. Подключите телефон к тому же VPN/LAN, что и ПК (WireGuard, Tailscale и т.п.).
3. Узнайте IP ПК в VPN/LAN (не `0.0.0.0` и не `localhost`) и откройте на телефоне `http://IP_ПК:5173`.
4. При необходимости разрешите входящий TCP **5173** (и **3001**) в файрволе Windows.
5. В UI: **Настройки → Телефон и VPN** — краткая шпаргалка и копирование текущего адреса. Кнопка **Установить** в тулбаре добавляет сайт на домашний экран.

`http://0.0.0.0:5173` в браузере не работает — это только адрес прослушивания сервера.

## Cursor / OpenCode / OMP / PI

1. Установите [Cursor CLI](https://cursor.com/docs/cli), OpenCode, OMP и/или PI (`pi` + `npm i -g pi-acp`).
2. Авторизуйтесь: `agent login` (или задайте `CURSOR_API_KEY` в настройках).
3. Проверьте ACP: `agent acp` (процесс должен стартовать и ждать JSON-RPC на stdin).
4. В UI → **Настройки** укажите command/args и `default cwd`.
5. Создайте чат и отправьте сообщение.

- OpenCode: `opencode auth login`, command `opencode`, args `acp`
- OMP: command `omp`, args `acp`
- PI: command `pi-acp`, args пустые (нужен также `pi` CLI)

## Gitea (локально)

```bash
docker compose up -d
powershell -ExecutionPolicy Bypass -File .\scripts\setup-gitea.ps1
```

Скрипт создаст пользователя `acprocess` / `acprocess`, репо `demo` и выведет token.  
Вставьте token в **Настройки → Gitea**. UI: [http://localhost:3000](http://localhost:3000)

## Подключение агента

1. В **Настройки** выберите провайдер (OpenCode / Cursor / OMP / PI).
2. Укажите API key в правильном поле (если нужно):
  - OpenCode → `OPENCODE_API_KEY` (+ опционально Anthropic/OpenAI)
  - Cursor → `CURSOR_API_KEY`
3. Нажмите **Проверить подключение агента**.
4. Permission policy для локалки: `Всегда разрешать`.
5. Создайте чат и отправьте сообщение.

Если чат «завис» — нажмите **Стоп** и отправьте снова.

## Архитектура

Браузер ↔ REST/WS сервер ↔ spawn `agent acp` / `opencode acp` / `omp acp` / `pi-acp` (JSON-RPC NDJSON) ↔ Postgres.

События `session/update`, permissions, `cursor/ask_question`, `cursor/create_plan`, `cursor/task` отображаются в ленте чата.