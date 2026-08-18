# ACProcess

Самостоятельно размещаемый веб-харнесс для агентов по [ACP](https://agentclientprotocol.com/) (Cursor CLI / OMP).
Чат со стримом рассуждений, tool calls и субагентов, настройки, светлая/тёмная тема в стиле META.

## Стек

- `apps/web` — React + Vite + TypeScript
- `apps/server` — Fastify + WebSocket + ACP stdio bridge
- `packages/shared` — общие типы
- SQLite (один файл `data/acprocess.db`, встроенный через better-sqlite3)

## Быстрый старт

```bash
# 1. Env
copy .env.example .env   # Windows
# cp .env.example .env   # macOS/Linux

# 2. Install
npm install

# 3. Dev
npm run dev
```

> Схема БД создаётся автоматически при старте сервера (идемпотентный
> `ensureSchema`). Опционально: `npm run db:push` для (пере)создания через drizzle-kit.

- Web: [http://localhost:5173](http://localhost:5173)
- API: [http://localhost:3001](http://localhost:3001)
- Файл БД: `data/acprocess.db` (переопределяется через `DATABASE_PATH` в `.env`)

## Скриншоты

| Чат (светлая тема) | Чат (тёмная тема) | Настройки |
|---|---|---|
| ![Чат светлая](docs/screens/chat-light.webp) | ![Чат тёмная](docs/screens/chat-dark.webp) | ![Настройки](docs/screens/settings.webp) |

## Прод-сборка

`npm run build` собирает всё, дальше сервер сам отдаёт веб-UI — в проде
**один порт**:

```bash
npm run build
npm run start     # → http://localhost:3001 (UI + API + WebSocket)
```

### Портативный дистрибутив (Windows)

```bash
npm run dist
```

создаёт `dist-app/acprocess-win-x64.zip` — скомпилированный сервер, веб-UI,
пакеты воркспейсов и production `node_modules` (нативный better-sqlite3
внутри). Распакуйте куда угодно и запустите `start.cmd` (нужен Node >= 20).

> В zip зашит нативный бинарник better-sqlite3, поэтому собирайте его на той
> ОС/архитектуре, под которую распространяете (сейчас — Windows x64).

### Установка в один клик

Прикрепите `dist-app/acprocess-win-x64.zip` к
[GitHub release](https://github.com/Alek7eeey/acprocess/releases) с именем
`acprocess-win-x64.zip`, затем на чистой Windows-машине:

```powershell
irm https://raw.githubusercontent.com/Alek7eeey/acprocess/dev/scripts/setup.ps1 | iex
```

Скрипт проверит/установит Node 20+, скачает релиз, распакует в
`%LOCALAPPDATA%\acprocess` и запустит приложение (данные — в
`%LOCALAPPDATA%\acprocess\data`). Локальный бандл вместо скачивания:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -ZipPath .\dist-app\acprocess-win-x64.zip
```

Переменные окружения прода: `PORT` (по умолчанию 3001), `HOST` (по умолчанию
`0.0.0.0`), `DATABASE_PATH` (по умолчанию `<каталог приложения>/data/acprocess.db`).

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

Браузер ↔ REST/WS сервер ↔ запуск CLI харнесса через реестр адаптеров (`agent acp` / `omp acp`, JSON-RPC NDJSON) ↔ SQLite.

События `session/update`, permissions, вопросы, планы и карточки субагентов отображаются в ленте чата через нормализованные события адаптеров.
