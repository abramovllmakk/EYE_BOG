# Решения и отклонения от ТЗ

Здесь записаны решения, которые ТЗ оставило открытыми, и отклонения от него с причинами.

## Отклонения от ТЗ

1. **Для невалидного документа покрытие не считается вообще** (ТЗ: «поля из невалидной части не засчитывать»). В graphql-js нет надёжной границы «валидной части»: ошибка в одном фрагменте меняет смысл всего документа. Кроме того, п. 3.4 требует, чтобы поле было покрыто «в валидном запросе». Такой запрос проксируется, в журнале получает статус `invalid` с текстами ошибок и учитывается в счётчике `invalid`.
2. **Ошибка приведения variables тоже делает запрос `invalid`.** По спецификации GraphQL такой запрос не выполняется (request error).
3. **PostgreSQL сделан на этапе 2** (в плане это было согласовано). Схема БД с самого начала переносима; включается через `storage.driver: postgres` или `DATABASE_URL=postgres://…`.
4. **Зависимости сверх списка ТЗ**, каждая по делу:
   - `@fastify/busboy` — потоковый разбор multipart;
   - `prom-client` — `/metrics`;
   - `lru-cache` — кэш документов;
   - `fastify-type-provider-zod`, `@fastify/swagger`, `@fastify/swagger-ui` — OpenAPI из zod-схем;
   - `@fastify/static` — раздача UI;
   - `yaml` — конфиг;
   - `ws`, `graphql-ws` — WebSocket;
   - `pg` — PostgreSQL;
   - `autocannon` — нагрузочный тест.
5. **TypeScript 6.0, а не 7.** Последний typescript-eslint поддерживает TypeScript до 6.0. `graphql` взят 16.15: эталонный API `TypeInfo` и `visitWithTypeInfo` стабилен, yoga 6 его поддерживает.
6. **`X-Test-Suite` не становится метаданными прогона.** Это свойство отдельного теста, и оно хранится по операциям и тестам. Набор тестов на уровне прогона задаётся через `gqlcov run start --suite`.

## Решения по неоднозначностям

| Вопрос | Решение |
|---|---|
| Что считать «операцией» | root-поле `Query.*`, `Mutation.*`, `Subscription.*` |
| Глубина | у root-полей глубина 1; путь пишется именами полей, а не алиасов: `query.user.posts.author` |
| Фрагменты | обход через новый `TypeInfo(schema, typeCondition)` с префиксом пути; у поля сохраняется ближайший фрагмент (`fragments`). Циклы отсекает валидация, плюс есть защитный стек |
| Поле на интерфейсе | засчитывается `Interface.field`. У реализаций статус `via_interface`, в проценты он идёт только при `propagateInterfaceCoverage` |
| Union | член засчитан, если выбран фрагментом на нём самом или на интерфейсе, который он реализует. Фрагмент на сам union (`... on SearchResult`) и одиночный `__typename` членов не засчитывают |
| `@include`/`@skip` | вычисляются по variables (с учётом значений по умолчанию). Флаг `conditional` появляется только когда variables неизвестны (`variablesKnown: false`). В обычном HTTP-трафике variables всегда известны |
| Значения enum | считаются только во входных позициях: аргументы, input-поля, variables. Выходные enum (`VideoResolution` в демо) поэтому показываются непокрытыми. Это осознанно: выходные значения выбирает сервер, а не тест |
| Input-поле | засчитано, если ключ явно передан, в том числе со значением `null`. Значения по умолчанию из схемы не засчитываются. Значения по умолчанию переменных засчитываются, если переменная не передана |
| `% типов` в сводке | доля затронутых (`covered` + `partial`) не-скалярных типов; полностью покрытые выводятся отдельно |
| `requests` и `occurrences` | `requests` — сколько запросов содержали поле, `occurrences` — сколько раз оно выбрано (с алиасами) |
| Пути и алиасы | ограничены 50 путями и 25 алиасами на поле, чтобы агрегаты не росли без предела |
| Batch | каждая операция batch-запроса — отдельная запись журнала с `batch_index` |
| SSE и `@defer` | ответ передаётся потоком; задача анализа ставится после конца потока |
| Introspection-запросы клиентов | проксируются и считаются в `introspection`, на покрытие не влияют |
| APQ | хэш = sha256 текста запроса (совпадает с ключом `query_document`). Запрос только с хэшем — `unresolved`. Если такой запрос был выполнен backend-ом без ошибок, он переанализируется, когда связка станет известна. Если ответ — `PersistedQueryNotFound`, запрос остаётся `unresolved`: его повтор с текстом и даст покрытие |
| Схема при старте недоступна | используется последний сохранённый снапшот цели; если его нет, запросы получают статус `no_schema`, а `/readyz` отвечает 503 с подсказкой загрузить SDL |
| Прогон без `run start` | автопрогон на каждую комбинацию метаданных; закрывается по бездействию |
| Прогоны по заголовку или пути | создаются автоматически, не «захватывают» трафик без заголовков, закрываются по бездействию |
| Variables в журнале | по умолчанию `structure`: только типы значений. При `full` ключи, похожие на секреты, всё равно маскируются |
| Federation | владелец поля определяется по `@join__field(graph)`, `external: true` игнорируется; без директивы владельцы берутся из `@join__type` типа (ключевые поля принадлежат всем). Внутренние `join__*` и `link__*` скрыты. SDL supergraph-а хранится сырым, потому что `printSchema` теряет применённые директивы |

## Ожидаемое покрытие демо-набора

[`demo/traffic/expected-coverage.json`](../demo/traffic/expected-coverage.json) посчитан вручную по [`demo/server/src/schema.graphql`](../demo/server/src/schema.graphql) и [`demo/traffic/src/tests.mjs`](../demo/traffic/src/tests.mjs).

**Поля.** Всего 72:

| Тип | Полей |
|---|---|
| Node | 1 |
| Content | 6 |
| User | 11 |
| UserStats | 3 |
| Post | 9 |
| Video | 8 |
| Comment | 7 |
| CommentConnection | 3 |
| CommentEdge | 2 |
| PageInfo | 2 |
| Tag | 2 |
| Query | 9 |
| Mutation | 7 |
| Subscription | 2 |

Не покрыто 11:

- `Content.likes`;
- `Mutation.deletePost`, `Mutation.follow`, `Mutation.updatePost`;
- `Post.publishedAt`;
- `Subscription.commentAdded`;
- `UserStats.totalLikes` — тест «conditional skip» передаёт `withStats: false`, поэтому поле не засчитано;
- `Video.author`, `Video.likes`, `Video.publishedAt`, `Video.tags`.

**Операции.** Query 9/9, Mutation 4/7, Subscription 1/2.

**Аргументы.** Всего 29, не передан только `Query.users(first:)` → 23. Подробно по тестам 1–14:

| Где | Использовано | Всего |
|---|---|---|
| `User` | avatarUrl.size, posts.first, posts.status, followers.first | 4 |
| `Post` | body.format, comments.first, comments.order | 3 |
| `Query` | 10 (всё, кроме `users.first`) | 11 |
| `Mutation` | 5 | 9 |
| `Subscription` | 1 | 2 |

**Значения enum.** Использовано 11 из 25:

| Enum | Использовано |
|---|---|
| Role | 2/4 (ADMIN, EDITOR) |
| PostStatus | 2/3 (PUBLISHED, DRAFT) |
| TextFormat | 1/3 |
| SortOrder | 1/3 |
| VideoResolution | 0/3 |
| SearchKind | 3/4 |
| PostOrderField | 1/3 |
| SortDirection | 1/2 |

**Поля input.** Передано 15 из 22:

| Input | Передано |
|---|---|
| PostFilter | 4/5 |
| PostOrderInput | 2/2 |
| CreatePostInput | 5/5 |
| SeoInput | 2/3 |
| UpdatePostInput | 0/4 |
| AddCommentInput | 2/3 |

**Типы.** Затронуто 27 из 29: не затронуты только `UpdatePostInput` и `VideoResolution`.

**Запросы.** Всего 20:
- 17 одиночных тестов;
- batch из 2 операций;
- мутация-триггер для подписки.

Из них 1 невалидный и 1 introspection.

**Тестов** 18: 16 именованных, триггер и `unknown`.

**Сколько запросов использовали тип** (выборочно):

| Тип | Запросов | Какие |
|---|---|---|
| Query | 12 | тесты 1–8, обе операции batch (14), 17, 18 |
| Mutation | 5 | 9, 10, 11, 12 и мутация-триггер |
| User | 10 | 1, 2, 3, 4 (автор в ленте), 5 (автор поста и комментариев), 6 (поиск), 12, вторая операция batch, 17, 18 |

Introspection-запрос (16) типы не использует.

Сквозной тест `e2e/coverage.e2e.test.ts` сверяет каждое из этих чисел с API работающего стека.
