# GitLab CI

Схема: стартовать прогон → прогнать тесты через прокси → получить отчёт и diff с `main` → финишировать с порогом → опубликовать отчёт в MR.

gqlcov разворачивается один раз как сервис стенда (образ `server` из [`Dockerfile`](../Dockerfile)). В образе есть и CLI `gqlcov`, поэтому job может использовать тот же образ.

```yaml
# .gitlab-ci.yml
variables:
  GQLCOV_SERVER: https://gqlcov.stage.example:4001   # admin API
  GQLCOV_PROXY: https://gqlcov.stage.example:4000    # вместо настоящего GraphQL
  # GQLCOV_TOKEN — masked CI/CD variable, если включён auth.token

stages: [test, report]

api-tests:
  stage: test
  # Образ gqlcov основан на node:22 и содержит CLI gqlcov; подойдёт любой образ с Node и gqlcov.
  image: registry.example/gqlcov/server:latest
  before_script:
    - npm ci
  script:
    - export GQLCOV_RUN_ID=$(gqlcov run start --branch "$CI_COMMIT_REF_NAME" --build "$CI_PIPELINE_ID" --commit "$CI_COMMIT_SHA" --env stage --team "${TEAM:-qa}")
    - echo "GQLCOV_RUN_ID=$GQLCOV_RUN_ID" >> gqlcov.env
    # Единственное изменение для тестов — URL. Run id в пути изолирует параллельные пайплайны.
    - GRAPHQL_URL="$GQLCOV_PROXY/proxy/$GQLCOV_RUN_ID/graphql" npm test
  artifacts:
    reports:
      dotenv: gqlcov.env

coverage:
  stage: report
  image: registry.example/gqlcov/server:latest   # содержит /usr/local/bin/gqlcov
  needs: [api-tests]
  script:
    - gqlcov report "$GQLCOV_RUN_ID" --format markdown --compare-branch main > coverage.md
    - gqlcov report "$GQLCOV_RUN_ID" --format json > coverage.json
    - gqlcov report "$GQLCOV_RUN_ID" --format csv > coverage.csv
    - |
      if [ -n "$CI_MERGE_REQUEST_IID" ] && [ -n "$GITLAB_API_TOKEN" ]; then
        node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({body:fs.readFileSync("coverage.md","utf8")}))' > note.json
        curl --fail -sS -X POST -H "PRIVATE-TOKEN: $GITLAB_API_TOKEN" -H "Content-Type: application/json" \
          --data @note.json \
          "$CI_API_V4_URL/projects/$CI_PROJECT_ID/merge_requests/$CI_MERGE_REQUEST_IID/notes"
      fi
    # Ненулевой код (3), если покрытие полей ниже 60% или операций ниже 70%: job падает.
    - gqlcov run finish "$GQLCOV_RUN_ID" --min-field-coverage 60 --min-operation-coverage 70
  artifacts:
    when: always
    paths: [coverage.md, coverage.json, coverage.csv]
```

## Что получится в MR

`gqlcov report --format markdown --compare-branch main` выводит:

- таблицу метрик: поля, типы, операции, аргументы, enum, input;
- колонку «Δ п.п.» относительно последнего завершённого прогона `main`;
- раскрывающиеся списки «стали покрыты», «потеряно покрытие» и «непокрытые операции»;
- строку об изменении схемы, если версии разные.

## Варианты

- **Без изменения кода тестов вообще.** Если тесты берут URL из переменной окружения, достаточно `GRAPHQL_URL=$GQLCOV_PROXY/graphql`. Запросы попадут в прогон, открытый `gqlcov run start`. Это подходит, только если пайплайны на этом прокси не идут одновременно; иначе используйте `/proxy/$GQLCOV_RUN_ID/graphql`.
- **Имена тестов.** Заголовки `X-Test-Name` / `X-Test-Suite` из общего GraphQL-клиента тестов включают разрез «поле → тесты».
- **Introspection на стенде выключен.** Добавьте в `api-tests` шаг `gqlcov schema upload schema.graphql`.
