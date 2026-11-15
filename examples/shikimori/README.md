# Пример: настоящий российский API — Шикимори

[Шикимори](https://shikimori.io) — открытая база аниме и манги с публичным GraphQL API (`https://shikimori.io/api/graphql`). Пример показывает, что gqlcov работает с чужим настоящим сервером без изменений в нём.

```bash
# 1. Добавить Шикимори второй целью к запущенному стеку
docker compose -f docker-compose.yml -f examples/shikimori/compose.yml up -d

# 2. Прогнать 10 «автотестов» через прокси
RUN_ID=shikimori-1 node examples/shikimori/run.mjs

# 3. Открыть отчёт
open "http://localhost:4001/graph?run=shikimori-1"
```

Тесты ([tests.mjs](tests.mjs)) отправляют запросы на `http://localhost:4000/t/shikimori/graphql` вместо `https://shikimori.io/api/graphql`. Больше в них ничего не меняется.

Что показал прогон (ноябрь 2026):

- поля: 54 из 247 (21,9%), операции: 6 из 10;
- ни разу не вызваны `Query.users`, `Query.userRates`, `Query.currentUser` и мутация `testField`;
- у Шикимори лимит глубины запроса — 5 уровней, а стандартный introspection-запрос пропускается, поэтому схема загружается автоматически;
- русские имена тестов передаются через `encodeURIComponent`, потому что `fetch` не отправляет кириллицу в заголовках как есть.

У публичного API есть лимиты (5 запросов в секунду, 90 в минуту), поэтому `run.mjs` делает паузы между запросами.
