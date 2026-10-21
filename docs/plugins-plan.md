# Плагинная система — спека v1 и план работ

**Прогресс отмечается прямо в этом файле:** `[ ]` — не сделано, `[*]` — сделано.
Отметку ставит тот, кто сделал; задача без отметки считается несделанной.

**Статус:** этапы 0–4 сделаны (контракты, источник+манифест, загрузчик+реестр, MCP-эндпоинт
для тулзов плагинов, провайдеры моделей с ключом). Этап 5 (шаблоны и CLI) намеренно не начат:
в плане он гейтится «после двух реальных плагинов», а шаблон, выведенный из одного фикстура,
описывал бы воображаемый API. Осталось только две ручные проверки (в этапах 3 и 4).

V1 — это ровно то, что нужно для двух вещей: **встроенные MCP-серверы из плагинов**
(тулзы пишет плагин, харнес их видит как обычный удалённый MCP) и **провайдеры моделей
из плагинов** (пользователь вбивает только ключ, рекомендованные модели уже в пикере).
Всё остальное осознанно отложено (см. «Отложено» в конце).

---

## 1. Пакет контрактов `@acpio/plugin-api`

Только типы, ноль рантайма, один файл. Плагин подключает его как **devDependency**:
в собранном бандле от него ничего не остаётся (`import type` стирается).

```ts
/** Определение плагина: его возвращает default-export бандла плагина. */
export interface PluginDefinition {
  /** Машиночитаемый id, совпадает с id в манифесте. */
  id: string;
  extensions: AcpPluginExtensionPoint[];
}

/** Одна плоская запись реестра: все точки расширения в одном объекте. */
export interface AcpPluginExtensionPoint {
  mcpServer?: McpServerContribution | McpServerContribution[];
  modelProvider?: ModelProviderContribution | ModelProviderContribution[];
}

export interface PluginRegistrationContext {
  /** Конфиг плагина из манифеста (поле `config`), как есть. */
  config: JsonObject;
  /** Каталог бандла: data/plugins/<id>/<version>-<hash>/ */
  home: string;
  log: PluginLogger;
}
export type JsonObject = Record<string, unknown>;
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

// ── mcpServer ───────────────────────────────────────────────────────────────

export interface McpServerContribution {
  /** Короткий id внутри плагина. Полный ключ: "<pluginId>:<serverId>". */
  id: string;
  /** Имя для UI. В ACP уходит как `name` сервера (от него зависит префикс тулзов). */
  label: string;
  description?: string;
  /** JSON-конфиг (креды и пр.): defaults ← config манифеста ← правки пользователя. */
  config?: { defaults?: JsonObject; sample?: JsonObject };
  /** false → сервер виден в списке как «не настроен» и к агенту не цепляется. */
  isConfigured?(config: JsonObject): boolean;
  create(ctx: McpServerContext): PluginMcpServer | Promise<PluginMcpServer>;
}

export interface McpServerContext {
  config: JsonObject;
  log: PluginLogger;
  plugin: { id: string; version: string; home: string };
}

export interface PluginMcpServer {
  tools: Record<string, PluginTool>;
}

export interface PluginTool {
  description: string;
  /** JSON Schema, уходит в tools/list как inputSchema. */
  schema: unknown;
  /** true → annotations.readOnlyHint, тулз предлагается и в не-agent режимах. */
  readOnly?: boolean;
  handler(input: unknown): Promise<string | { text: string; isError?: boolean }>;
}

// ── modelProvider ───────────────────────────────────────────────────────────

export interface ModelProviderContribution {
  /** Короткий id внутри плагина. Полный id: "<pluginId>:<providerId>". */
  id: string;
  label: string;
  description?: string;
  /** OpenAI-совместимый base URL. */
  baseUrl: string;
  /** Куда пользователю идти за ключом (ссылка/текст подсказки). */
  apiKeyHint?: string;
  /** Статичные заголовки; `{{sessionId}}` подставляется ядром. */
  headers?: Array<{ name: string; value: string }>;
  /** Рекомендованные модели: приходят в пикер уже добавленными и включёнными. */
  models: Array<{ id: string; label: string; contextWindow: number; enabled?: boolean }>;
  /** Доп. JSON в тело запроса (провайдерские ручки). */
  body?: string;
}
```

## 2. Источник конфигурации

Настройка `settings.pluginsConfig: string` — **URL или путь**, разбор в одном месте:

- начинается с `http://`, `https://` или `file://` → URL (иначе `C:\plugins\config.json`
  разберётся как URL со схемой `c:`);
- иначе → путь: `~` = домашний каталог сервера, обратные слэши → прямые,
  относительный путь — от cwd процесса сервера;
- внутри манифеста относительные пути (`./dist/server.js`) резолвятся **от расположения
  манифеста** — одно правило и для файла, и для URL.

Дефолт — `data/plugins/config.json` (папка плагинов из коробки, без внешнего хостинга).
Отсутствие дефолтного файла — не ошибка: это нормальный случай, когда плагины добавляют
руками (ниже).

Рядом — **прямое добавление**: `settings.pluginEntries` (Settings → Плагины → «Добавить
плагин») — те же поля, что у записи манифеста, но без файла:

```json
[{ "id": "my-plugin", "server": "C:/proj/my-plugin/dist/server.js",
   "config": { "tenant": "acme" } }]
```

Файл — способ указать несколько плагинов сразу (команда, провижен одним URL), строки в
настройках — способ добавить один, не заводя файл. Оба источника читаются на boot, один id —
один плагин: строка из настроек побеждает запись с тем же id из файла, и это видно в
предупреждениях. У строки нет «базовой папки», поэтому относительный путь в ней считается от
cwd сервера (у записи манифеста — от папки манифеста).

## 3. Манифест

```json
{ "schema": 1, "plugins": [
  { "id": "my-plugin", "version": "0.1.0", "enabled": true,
    "server": "./dist/server.js",
    "config": { "tenant": "acme" } }
] }
```

`server` — строка или `{ "url": … }`. `web` в v1 **не читается** (веб-плагинов нет):
запись с `web` не ошибка, просто игнорируется.

## 4. Загрузка на boot

1. Источник недоступен → берём последний удачный манифест с диска
   (`data/plugins/manifest.json`), приложение работает, UI говорит дату манифеста.
2. Для каждой включённой записи: `data/plugins/<id>/<version>-<hash>/`.
   Каталог есть — ничего не делаем; нет — читаем локальный файл или качаем URL,
   считаем sha256, пишем атомарно (tmp → rename).
3. `import()` бандла в try/catch → `default(ctx)` → в общий плоский массив точек расширения.
   Падение одного плагина не роняет boot и остальные плагины.
4. **Hot reload нет.** Манифест читается на старте; новая версия — после перезапуска
   сервера. Реестр неизменяем после boot, `unregisterAll` не делаем.

## 5. Точка `mcpServer` → удалённый MCP-сервер

Один эндпоинт `POST /api/mcp/plugin/<pluginId>/<serverId>` на том же порту, что UI.
Разрешения и транспорт — уже существующие: плагинный сервер попадает в
`effectiveMcpServers()` как обычный `McpServerConfig` (`type: "remote"`), url
перезаписывается рантайм-портом и boot-токеном перед `session/new` — ровно как
сделано для `acpio_bg` (`BG_MCP_SERVER_ID`, `resolveBackgroundMcp`, `MCP_TOKEN`).
Значит тулзы получают все харнесы (builtin, Cursor, OMP, opencode) и **ничего в
`adapter-builtin` править не надо**.

- методы: `initialize`, `notifications/initialized` (202), `tools/list`, `tools/call`,
  неизвестный → JSON-RPC `-32601`;
- `tools/list` — из контрибуции, **без вызова handler'ов**;
- `tools/call` — handler, результат клипуется (30k), таймаут 180s, ошибка → `isError`,
  а не разрыв соединения;
- без валидного токена → 403; выключен/не загружен → 404;
- `name` сервера = `<serverId>`, уникальность по всем плагинам проверяется на boot;
- в `mcpServersFingerprint` добавляется `pluginId@version`, иначе апгрейд плагина
  не переподключит MCP в существующей сессии.

## 6. Точка `modelProvider` → строка провайдера

Определения плагина **не пишутся в `settings.builtinProviders`** (сохранённая копия
затёрла бы обновление плагина). Хранится только пользовательская часть:

```ts
settings.pluginProviders?: Record<string /*"<pluginId>:<providerId>"*/, {
  apiKey?: string;
  enabled?: boolean;
  urlOverride?: string;
  /** Только правки и добавленные вручную строки. */
  models?: BuiltinModelConfig[];
}>;
```

Слияние: рекомендации плагина — база; пользовательская строка с тем же `model id`
перекрывает label/окно/`enabled`; пользовательские добавленные доклеиваются; удаления
нет — есть `enabled: false`. В UI строка выглядит как обычный провайдер, но `url` и
модели readonly (плюс «сбросить к значениям плагина»), заполнять нужно **только ключ**.
Пока ключа нет — провайдер в пикер не отдаётся. Каталог моделей — существующая кнопка
(`fetchBuiltinModelCatalog`, `/api/agent/builtin/models`).

## 7. Настройки и UI (v1)

- `settings.pluginsConfig: string`, `settings.pluginProviders: Record<…>`;
- секция «Плагины» в существующем `SettingsPage`: поле источника + «Проверить»
  (сервер читает манифест и показывает, что нашёл: id, версии, ошибки, разрешённый
  абсолютный путь для локального файла) + таблица загруженных плагинов с состоянием
  и тем, что плагин дал (MCP-серверы и число тулзов, провайдеры и число моделей);
- `GET /api/plugins` — то же в JSON для UI.

## 8. Отложено (не делать сейчас)

Веб-плагины и весь веб-хост, шаблоны и `acpio-plugin init`, дрейф версий и авто-проверки,
`disabledPluginIds`, чистка старых версий, `integrity`/`requires.core`/capabilities,
`route`, `settingsSection`, доски (`boardPreset`, `boardLaneResolver`), `taskSource`,
`partRenderer`, i18n, темы, `discoverModels`, SSE, раскатка конфига по URL для команды.

---

## Задачи

### Этап 0. Контракт — сделан

- [*] `packages/plugin-api`: `package.json`, `tsconfig.json`, один `src/index.ts` с типами из §1
- [*] Скрипт `pack:api` (`npm pack -w @acpio/plugin-api --pack-destination ./tmp`)
- [*] `packages/plugin-example` (workspace): плагин руками — 1 MCP-сервер с 1 тулзом и 1 провайдер,
      сборка в `dist/server.js`, self-check тестом
- [*] Проверка: `npm pack` даёт tgz (tmp/acpio-plugin-api-0.1.0.tgz), пример собирается и грузится от него

Отклонение от плана: пример собирается `tsc`, а не esbuild — он помещается в один файл, `import type`
стирается, и `dist/server.js` выходит самодостаточным (проверено: ни одного `import` в выводе).
Новая зависимость не понадобилась.

### Этап 1. Настройки, источник, манифест — сделан

- [*] `settings.pluginsConfig` в `AppSettings` + `DEFAULT_SETTINGS` + нормализация в `services/settings.ts`
- [*] Разбор источника «URL или путь» (`~`, слэши, `http(s)://`, `file://`) одной функцией + тест на `C:\plugins\config.json`
- [*] Чтение манифеста: URL (`no-store`, таймаут 15s) | файл; кэш на диск `data/plugins/manifest.json`; деградация при недоступном источнике
- [*] Схема записи манифеста + валидация (zod) с внятными ошибками по записи
- [*] Резолв относительных путей внутри манифеста от его расположения + тест
- [*] `GET /api/plugins`: что нашлось в источнике, что загружено, состояние, разрешённый путь, `pendingRestart`
- [*] Секция «Плагины» в настройках: поле источника, «Проверить», таблица плагинов, предупреждения

Отклонение: в навигации настроек это отдельный пункт «Плагины» в разделе «Агент»
(`settingsNav.ts`), а не отдельная страница — дешевле и попадает в существующий поиск по настройкам.

### Этап 2. Загрузчик — сделан

- [*] Каталог `data/plugins/<id>/<version>-<hash>/`: чтение локального файла или скачивание, sha256, атомарная запись
- [*] Одинаковый файл — не перекопируем (hash тот же)
- [*] `import()` в try/catch → `default(ctx)` → плоский массив точек; падение плагина не рвёт boot
- [*] Реестр: `extensions()` и `selectExtensions(map)`
- [*] Тест загрузки локального плагина из tmp-каталога (успех, битый файл, падение при импорте)
- [*] Тест сквозной: настройка → манифест → резолв относительного пути → кэш → `import()` → реестр,
      плюс недоступный источник как состояние, а не исключение

Отклонение: каталог плагинов переопределяется `ACPIO_PLUGINS_DIR` (как `DATABASE_PATH` у БД) —
иначе тесты писали бы в рабочие `data/plugins`.

### Этап 3. `mcpServer` — сделан

- [*] Плагинные MCP-серверы в реестре встроенных серверов, id `plugin:<pluginId>:<serverId>`, глобальный тумблер в `mcpBuiltinDisabledIds`
- [*] url с рантайм-портом и boot-токеном
- [*] Эндпоинт `POST /api/mcp/plugin/<pluginId>/<serverId>`: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `-32601` на прочее
- [*] Токен: 403 без валидного, 404 на выключенный/неизвестный сервер
- [*] Имена тулзов `mcp__<serverId>_<toolId>` (санитайзер `[^A-Za-z0-9_-] → _`), `readOnly` → `annotations.readOnlyHint`
- [*] Клип результата 30k, таймаут вызова 180s, ошибка плагина → `isError`
- [*] Уникальность `name` по всем плагинам на boot
- [*] Число тулзов и статус плагинных серверов в `/api/mcp/status`
- [*] Тесты: `tools/list`, `tools/call` (успех/ошибка/клип), таймаут, батч, 403 без токена, 404 на неизвестный
- [ ] Ручная проверка: чат на builtin вызывает плагинный тулз; то же на Cursor или OMP

Отклонения:
- JSON-RPC вынесен из `bgMcp.ts` в `services/servedMcp.ts` (один каркас на два эндпоинта) — `handleBackgroundMcpRequest` сохранил сигнатуру
- отдельная перезапись url перед `session/new` не понадобилась: `pluginMcpServers(settings)` сразу отдаёт порт и токен (токен не зависит от сессии, в отличие от `acpio_bg`)
- `pluginId@version` в `mcpServersFingerprint` не добавлял: url уже содержит токен этого boot, а реестр неизменяем до перезапуска — отпечаток меняется и без версии

### Этап 4. `modelProvider` — сделан

- [*] `settings.pluginProviders` в `AppSettings` + нормализация (`healPluginProviders`)
- [*] Materialize провайдера из контрибуции + слияние с пользовательскими правками (рекомендации ← правки)
- [*] Строка провайдера в Settings → Built-in agent: только ключ, url/модели из плагина, «сбросить»
- [*] Без ключа провайдер не отдаётся в пикер моделей (`enabled: false`, пока ключа нет)
- [*] Рекомендованные модели включёнными; свои модели и правки окон пользователь сохраняет
- [*] Тест слияния: правки и добавленные вручную модели переживают обновление рекомендаций
- [*] Тест: апгрейд плагина добавляет новые модели, не затирая правки
- [ ] Ручная проверка: ключ → модель в пикере → ход в чате проходит

Отклонения:
- провайдеры подмешиваются в `getSettings()` (через `setPluginProviderSource` — loader импортирует settings, обратной зависимости нет), поэтому пикер, транспорт и каталог моделей видят их без правок
- `updateSettings` вырезает строки с `pluginId` при записи, иначе submit формы сохранил бы копию плагинного провайдера в БД
- `healBuiltinProviders` научен сохранять `pluginId`/`apiKeyHint`, иначе они терялись при лечении настроек
- порядок моделей: сначала рекомендации плагина в его порядке, потом добавленные пользователем

## Как проверяем, что плагины работают

Три слоя, от самого внешнего к внутреннему:

1. **Настоящий плагин — приёмочный тест** `apps/server/test/pluginExample.test.ts`. Гоняет
   `packages/plugin-example` сквозь загрузчик и дальше через те две двери, которыми пользуется
   приложение: MCP-эндпоинт (`tools/list`, `tools/call`) и список моделей
   (`builtinModelOptions`). Там же проверяются обе половины конфига (значение из
   `config.mcp.demo.greeting` доезжает до `create()` и до результата тулза) и гейт по ключу
   (без ключа рекомендаций в выборе нет, с ключом — обе, с адресом плагина). Границу «сломали»
   видно сразу: тест падает, если потерять `readOnly` или перестать передавать конфиг в `create()`.
   Пример на TypeScript, поэтому тест сам его собирает, если `dist/server.js` нет, —
   `npm test` работает и на чистом клоне.
2. **Манифест рядом с примером** — `packages/plugin-example/acpio-plugins.json`: то же, что
   тест, но руками. Settings → Плагины → путь `<repo>/packages/plugin-example/acpio-plugins.json`
   → перезапуск сервера → тулз `mcp__demo_greet` в чате и строка «Demo provider» в
   Built-in agent. Путь в манифесте относительный (`./dist/server.js`) — резолвится от
   папки манифеста, так что ничего копировать не нужно.
   Тот же плагин можно добавить и строкой, без файла: id `example`, путь
   `<repo>/packages/plugin-example/dist/server.js`, config `{"mcp":{"demo":{"greeting":"Привет"}}}` —
   это проверяется тем же тестом (в нём есть отдельный кейс «added by hand»).
3. **Фикстуры внутри тестов** (`plugins.test.ts`, `pluginsRoute.test.ts`,
   `pluginProviders.test.ts`) — маленькие бандлы в `os.tmpdir()`. Это про границы самого
   загрузчика: битый бандл, коллизия имён, невыполненный `isConfigured`, слияние правок,
   апгрейд — то, что в примере не воспроизведёшь без его порчи.

Чего пока нет и почему: `acpio-plugin init`/`pack` и шаблон (этап 5) — до второго настоящего
плагина. Пока контракт держит компиляция: `packages/plugin-example` собирается в общем
`npm run build` только если `@acpio/plugin-api` всё ещё его принимает, а приёмочный тест —
если загрузчик всё ещё его отдаёт в чат.

### Этап 6. Прямое добавление плагинов — сделан

- [*] `settings.pluginEntries` в `AppSettings` + нормализация (`healPluginEntries`)
- [*] Загрузчик: строки из настроек + записи манифеста одним проходом, один id — один плагин (строка побеждает), предупреждение на дубль и на невалидный id
- [*] Отсутствие дефолтного `config.json` больше не даёт warning, если есть только строки
- [*] UI: строки в Settings → Плагины (id, путь/URL бандла, config JSON, тумблер, удалить, «+ Добавить плагин»), статус загрузки прямо в строке, «не сохранено как JSON» при неразобранном конфиге
- [*] `pendingRestart` учитывает и строки, и источник (`sourceKey`)
- [*] Тесты: строка без файла конфигурации (тулз получает config из строки), победа над дублем в файле, строки UI в форме

### Этап 5. Шаблоны и CLI (после двух реальных плагинов — ещё не начат)

- [ ] Зафиксировать, что получилось, и вынести из `plugin-example` шаблон
- [ ] `acpio-plugin init` (шаблоны файлами), `pack` (запись манифеста с version+hash), отказ на несовпадении мажора контракта
- [ ] `AGENTS.md` в шаблоне: контракт, правила v1, цикл разработки, проверка `tools/list` курлом
