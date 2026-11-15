# GraphQL Coverage Proxy («Сеть глазами Бога»)

Прозрачный HTTP/WebSocket-прокси между автотестами и настоящим GraphQL API. Каждый запрос разбирается по схеме, и сервис считает, какие **типы, поля, аргументы, значения enum, поля input-объектов, связи и операции** реально затронуты тестами. Запрос без изменений уходит на backend. UI показывает граф схемы в духе GraphQL Voyager, раскрашенный по покрытию.

Автотесты и CI не меняются: поменять нужно только URL GraphQL-эндпоинта.

```
 автотесты ──► gqlcov :4000 ──► настоящий GraphQL API
                  │
                  └─► очередь анализа ─► SQLite / PostgreSQL ─► REST API ─► UI :4001
```

## Quick start за 2 минуты

Нужны Docker и docker compose.

```bash
docker compose up -d --build          # демо-API :4100, прокси :4000, UI и API :4001
docker compose run --rm traffic       # 18 демо-«автотестов» шлют трафик через прокси
open http://localhost:4001            # дашборд прогонов → граф → таблица → запросы
```

- UI и дашборд: http://localhost:4001
- OpenAPI (Swagger UI): http://localhost:4001/docs
- Prometheus: http://localhost:4001/metrics
- GraphQL для тестов: http://localhost:4000/graphql

Без Docker (Node 22, pnpm 10):

```bash
pnpm install && pnpm build
PORT=4100 node demo/server/dist/main.js &
node apps/server/dist/main.js gqlcov.example.yaml &
node demo/traffic/src/run.mjs
```

## Как подключить свои тесты

1. Запустите gqlcov с `TARGET_URL=https://api.stand.example/graphql` (или пропишите цель в YAML-конфиге).
2. В тестах замените URL GraphQL на `http://<gqlcov>:4000/graphql`. **Больше ничего менять не нужно.**
3. Необязательные заголовки обогащают отчёт:

| Заголовок | Значение |
|---|---|
| `X-Test-Name`, `X-Test-Suite` | имя теста и набора: разрез «поле → тесты» и «тест → поля». Без них тест записывается как `unknown` |
| `X-Coverage-Run-Id` | явная привязка к прогону |
| `X-Coverage-Env`, `X-Coverage-Branch`, `X-Coverage-Build`, `X-Coverage-Commit`, `X-Coverage-Team` | метаданные прогона |

Заголовки `X-Coverage-*` вырезаются до отправки на backend. Имена всех заголовков настраиваются.

**Как прокси понимает, к какому прогону относится запрос** (в порядке приоритета):

1. заголовок `X-Coverage-Run-Id` или префикс пути `/proxy/<runId>/graphql` (это тоже «только URL»);
2. последний прогон, открытый через API/CLI: `gqlcov run start` … `gqlcov run finish`;
3. иначе автоматический прогон на каждую комбинацию метаданных; он закрывается после `runs.idleTimeoutSec` бездействия.

Если несколько CI-пайплайнов **одновременно** гонят тесты через один прокси, используйте вариант 1 (`/proxy/$RUN_ID/graphql`), иначе их трафик попадёт в один «последний» прогон.

### CLI для CI

```bash
export GQLCOV_SERVER=http://gqlcov:4001
RUN=$(gqlcov run start --branch "$CI_COMMIT_REF_NAME" --build "$CI_PIPELINE_ID" --env stage)
npm test                                            # тесты ходят в http://gqlcov:4000/graphql
gqlcov report "$RUN" --format markdown --compare-branch main > coverage.md
gqlcov run finish "$RUN" --min-field-coverage 60    # код выхода 3, если ниже порога
gqlcov schema upload schema.graphql                 # если на стенде выключен introspection
```

Полный пример GitLab CI с комментарием в MR: [docs/ci.md](docs/ci.md).

## Метрики покрытия

Определения зафиксированы в коде: [`packages/core/src/coverage.ts`](packages/core/src/coverage.ts).

- **Поле** `Type.field` покрыто, если хотя бы раз выбрано в **валидном** запросе. `requests` — число запросов, где поле встретилось; `occurrences` — общее число вхождений (alias одного поля дважды даёт 2 вхождения и 1 запрос).
- Introspection (`__schema`, `__type`) и `__typename` не учитываются. Невалидные запросы проксируются, но покрытия не дают (в журнале статус `invalid` и тексты ошибок).
- **Object / Interface**: `covered` — покрыты все поля (зелёный), `partial` — часть (жёлтый), `uncovered` — ни одного (серый). Процент = покрытые поля / все поля.
- **Поле через интерфейс**: если выбран `Content.title`, у реализаций `Post.title` и `Video.title` статус «покрыто через интерфейс» (штриховка). В проценты они идут только при `coverage.propagateInterfaceCoverage: true`. По умолчанию нет.
- **Union**: доля членов, выбранных через фрагмент на этом члене (или на интерфейсе, который он реализует).
- **Enum**: доля значений, использованных в аргументах и input-объектах (литералами и через variables).
- **Input-тип**: доля полей, которые реально переданы. **Аргумент**: передан или нет.
- **Операции**: доля root-полей Query/Mutation/Subscription, которые вызывались.
- **Связи**: поля с составным возвращаемым типом (ребро `Parent.field → Child`), покрыто = поле покрыто.
- **Типы, % по прогону**: доля не-скалярных типов, которые затронуты (`covered` или `partial`). Отдельно выводится число полностью покрытых.
- `@include`/`@skip`: условие вычисляется по переданным variables. Ветка, которая точно выключена, не засчитывается. Если значение неизвестно (переигрывание журнала с редактированными variables), поле засчитывается с флагом `conditional`.
- **Federation**: для supergraph SDL каждое поле привязывается к сервису-владельцу (`@join__field`, иначе `@join__type`), покрытие считается по сервисам.

Два разреза из ТЗ: **schema coverage** (что вообще затронуто) и **test coverage** (поле → список тестов, тест → список полей): `GET /api/runs/:id/fields/:coordinate`, `GET /api/runs/:id/tests/:testKey/fields`.

## Конфигурация

Один YAML-файл ([`gqlcov.example.yaml`](gqlcov.example.yaml)) плюс переопределения через env. Всё валидируется zod, при ошибке выводится понятное сообщение.

- `GQLCOV_<СЕКЦИЯ>__<КЛЮЧ>`, например `GQLCOV_SERVER__PROXY_PORT=8080`, `GQLCOV_TARGETS__0__URL=…`, `GQLCOV_LOGGING__VARIABLES=none`;
- сокращения: `TARGET_URL`, `AUTH_TOKEN`, `DATABASE_URL` (`postgres://…` включает PostgreSQL), `GQLCOV_CONFIG` (путь к YAML).

| Секция | Что настраивает |
|---|---|
| `server` | порты прокси (4000) и UI/API (4001), лимит тела, каталог UI |
| `targets[]` | имя, URL backend, источник схемы (`introspection` или `sdl` + `file`), заголовки introspection, интервал обновления схемы, правила заголовков `add` / `override` / `remove`. Первая цель доступна на `/graphql`, каждая — на `/t/<name>/graphql`; у каждой своя версия схемы |
| `runs` | имена заголовков, вырезаемые префиксы, таймаут автопрогона |
| `logging` | уровень, маскируемые заголовки, политика variables: `none` / `structure` (по умолчанию, только типы значений) / `full` (значения, но ключи вроде `password` и `token` маскируются) |
| `retention` | сколько дней хранить сырой журнал запросов (агрегаты хранятся всегда) |
| `auth.token` | Bearer-токен для `/api` и UI |
| `coverage` | `propagateInterfaceCoverage` |
| `storage` | `sqlite` (файл) или `postgres` (URL) |
| `queue`, `cache` | размер очереди анализа, период сброса в БД, LRU разобранных документов |

## Что внутри

| Пакет | Назначение |
|---|---|
| [`packages/core`](packages/core) | анализатор запросов и модель покрытия: чистая логика без I/O, 100% покрытие unit-тестами, фикстуры по всем кейсам ТЗ |
| [`apps/server`](apps/server) | Fastify: прокси (HTTP, batch, multipart, SSE, WebSocket), очередь анализа, хранилище (Drizzle: SQLite / PostgreSQL), REST API + OpenAPI, метрики |
| [`apps/web`](apps/web) | React UI: прогоны, граф (React Flow + ELK в Web Worker), таблица, тип, поле, запрос, heatmap, сравнение, динамика |
| [`packages/cli`](packages/cli) | `gqlcov` для CI |
| [`demo/server`](demo/server), [`demo/traffic`](demo/traffic) | демо-API на graphql-yoga и демо-тесты с ожидаемым покрытием, посчитанным вручную |

Архитектура: [docs/architecture.md](docs/architecture.md). Принятые решения и отклонения от ТЗ: [docs/decisions.md](docs/decisions.md).

## Проверка

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit (core, 100%), интеграционные (сервер), CLI
docker compose up -d --build
pnpm test:e2e                              # демо-тесты через стек: числа = expected-coverage.json
pnpm test:ui                               # Playwright: граф → тип → поле → запрос
pnpm test:pg                               # контракт хранилища и приложение на PostgreSQL (нужен Postgres)
pnpm bench                                 # autocannon: overhead прокси
```

## Накладные расходы прокси

Apple M5, Node 22, нативные процессы, каждый запрос анализируется и пишется в журнал ([bench/RESULTS.md](bench/RESULTS.md)):

| Нагрузка | Напрямую p50 / p97.5 / p99 | Через прокси p50 / p97.5 / p99 | Собственный overhead прокси, p95 |
|---|---|---|---|
| 2000 req/s | 0 / 3 / 3 мс | 1 / 4 / 6 мс | ≤ 0,5 мс |
| насыщение, 20 соединений | 0 / 1 / 1 мс (31 тыс. req/s) | 1 / 6 / 7 мс (11,9 тыс. req/s) | ≤ 0,5 мс |

Анализ и запись в БД выполняются вне критического пути, квантами по ~2 мс и транзакциями по 100 строк, поэтому не блокируют проксирование. Требование ТЗ «p95 < 5 мс без учёта backend» выполнено. Пропускная способность одного процесса около 12 тыс. req/s: это потолок однопоточного Node, а не проблема анализа.

## Большие схемы

Граф проверен на синтетической схеме из 1204 типов (8 полей у каждого). Раскладка ELK считается в Web Worker; рендерятся только видимые узлы, а длинные списки полей свёрнуты.

| Режим | Узлов на графе | Время до появления графа |
|---|---|---|
| «Вся схема» (автоматически ограничено окрестностью корня) | 150 | ~2,6 с |
| Фокус на типе, 2 уровня соседей | 49 | ~1,2 с |

Остальные типы доступны через поиск и фокус, а также через таблицу покрытия.

## Ограничения

- `@defer`/`@stream` и SSE проксируются потоково, но анализируется только исходный документ, а не инкрементальные части ответа.
- Флаг `has_errors` вычисляется по JSON-ответам до 1 МБ (`queue.responseInspectLimitBytes`) без `content-encoding`. Для сжатых ответов он пустой.
- Для запроса, у которого есть ошибки валидации, покрытие не считается вообще: в graphql-js нет надёжной границы «валидной части» документа.
- APQ: запрос только с хэшем учитывается как `unresolved`. Когда связка hash → query появится, уже выполненные запросы переанализируются. Повтор после `PersistedQueryNotFound` покрытием не считается.
- При нескольких одновременных пайплайнах на одном прокси нужен явный run id (см. выше).
- Анализ работает в одном процессе с прокси. Горизонтальное масштабирование — несколько экземпляров на общий PostgreSQL, у каждого свой run id или общий через заголовок.
- Покрытие federation считается по supergraph SDL. Introspection supergraph-а не содержит директив `@join__*`, поэтому SDL нужно загрузить (`gqlcov schema upload supergraph.graphql`).
