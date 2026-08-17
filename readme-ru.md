# ACProcess

Самостоятельно размещаемый веб-харнесс для агентов по [ACP](https://agentclientprotocol.com/) (Cursor CLI / OMP).
Чат со стримом рассуждений, tool calls и субагентов, настройки, светлая/тёмная тема в стиле META.

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

## Cursor / OMP

1. Установите [Cursor CLI](https://cursor.com/docs/cli) и/или OMP.
2. Авторизуйтесь: `agent login` (или задайте `CURSOR_API_KEY` в настройках).
3. Проверьте ACP: `agent acp` (процесс должен стартовать и ждать JSON-RPC на stdin).
4. В UI → **Настройки** укажите command/args и `default cwd`.
5. Создайте чат и отправьте сообщение.

- Cursor: command `agent`, args `acp`
- OMP: command `omp`, args `acp`

## Подключение агента

1. В **Настройки** выберите провайдера (Cursor / OMP).
2. Укажите API key в правильном поле (если нужно):
   - Cursor → `CURSOR_API_KEY`
3. Нажмите **Проверить подключение агента**.
4. Permission policy для локалки: `Всегда разрешать`.
5. Создайте чат и отправьте сообщение.

Если чат «завис» — нажмите **Стоп** и отправьте снова.

## Плагины харнессов

Ядро харнесс-агностично: Cursor и OMP — это **адаптеры-плагины**, зарегистрированные в
`apps/server/src/adapters/registry.ts`. Сторонний харнесс добавляется пакетом
`packages/adapter-*`, реализующим `HarnessAdapter`, — интерфейс подхватит его сам
(список провайдеров, поля CLI/API-ключа, модели) из `GET /api/adapters`.

- Документация: [docs/usage-ru.md](docs/usage-ru.md) — как пользоваться харнессами и плагинами
- [docs/adapters-ru.md](docs/adapters-ru.md) — как написать плагин под харнесс

## Архитектура

Браузер ↔ REST/WS сервер ↔ запуск CLI харнесса через реестр адаптеров (`agent acp` / `omp acp`, JSON-RPC NDJSON) ↔ Postgres.

События `session/update`, permissions, вопросы, планы и карточки субагентов отображаются в ленте чата через нормализованные события адаптеров.
