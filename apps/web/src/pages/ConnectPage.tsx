import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyButton } from '../components/GapQuery';
import { QueryView } from '../components/QueryView';
import { ErrorBox, Loading, Mono } from '../components/ui';
import { api, type Target } from '../lib/api';
import { dateTime } from '../lib/format';

const HEADERS: [string, string][] = [
  ['X-Test-Name', 'имя теста: разрезы «поле → тесты», «вклад тестов», след на карте'],
  ['X-Test-Suite', 'набор тестов: группировка и фильтр по набору'],
  ['X-Coverage-Run-Id', 'явный прогон; нужен, если несколько пайплайнов идут параллельно'],
  [
    'X-Coverage-Branch, -Env, -Build, -Commit, -Team',
    'метаданные прогона для сравнения, динамики и команд',
  ],
];

function snippets(url: string): { id: string; label: string; code: string }[] {
  return [
    {
      id: 'curl',
      label: 'curl',
      code: `curl -s ${url} \\
  -H 'content-type: application/json' \\
  -H 'x-test-name: viewer profile' -H 'x-test-suite: profile' \\
  --data '{"query":"{ viewer { id name } }"}'`,
    },
    {
      id: 'playwright',
      label: 'Playwright',
      code: `// playwright.config.ts: все запросы тестов идут через прокси
use: {
  baseURL: '${url}',
  extraHTTPHeaders: { 'x-coverage-branch': process.env.CI_COMMIT_REF_NAME ?? 'local' },
},

// в тесте имя подставляется автоматически
test('viewer profile', async ({ request }, info) => {
  const res = await request.post('', {
    headers: { 'x-test-name': encodeURIComponent(info.title) },
    data: { query: '{ viewer { id name } }' },
  });
  expect((await res.json()).errors).toBeUndefined();
});`,
    },
    {
      id: 'fetch',
      label: 'JS / Jest',
      code: `const GRAPHQL_URL = process.env.GRAPHQL_URL ?? '${url}';

export async function gql(query, variables, testName = expect.getState().currentTestName) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // fetch не пропускает кириллицу в заголовках: прокси раскодирует encodeURIComponent
      'x-test-name': encodeURIComponent(testName ?? 'unknown'),
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}`,
    },
    {
      id: 'python',
      label: 'Python',
      code: `import os, requests

GRAPHQL_URL = os.getenv("GRAPHQL_URL", "${url}")

def gql(query, variables=None, test_name=None):
    test_name = test_name or os.getenv("PYTEST_CURRENT_TEST", "unknown").split(" ")[0]
    r = requests.post(GRAPHQL_URL, json={"query": query, "variables": variables},
                      headers={"x-test-name": test_name})
    r.raise_for_status()
    return r.json()`,
    },
    {
      id: 'ci',
      label: 'CI',
      code: `export GQLCOV_SERVER=http://gqlcov:4001
RUN=$(gqlcov run start --branch "$CI_COMMIT_REF_NAME" --build "$CI_PIPELINE_ID" --env stage)
GRAPHQL_URL="http://gqlcov:4000/proxy/$RUN/graphql" npm test
gqlcov report "$RUN" --format markdown --compare-branch main > coverage.md
gqlcov gaps "$RUN" --format markdown --limit 10 >> coverage.md
gqlcov run finish "$RUN" --min-field-coverage 60   # код 3, если ниже порога`,
    },
  ];
}

/** How to point existing tests at the proxy: URLs, optional headers and copy-ready snippets. */
export function ConnectPage() {
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => api<Target[]>('/api/targets') });
  const [tab, setTab] = useState('curl');
  if (targets.error) return <ErrorBox error={targets.error} />;
  if (!targets.data) return <Loading what="цели" />;
  const proxy = `${location.protocol}//${location.hostname}:4000`;
  const first = targets.data[0];
  const url = `${proxy}${first?.proxyPath ?? '/graphql'}`;
  const list = snippets(url);
  const current = list.find((x) => x.id === tab) ?? list[0]!;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-xl font-semibold">Подключение тестов</h1>
      <p className="mt-1 max-w-prose text-muted">
        Код тестов менять не нужно: достаточно направить их на прокси вместо настоящего GraphQL API.
        Прокси передаёт запрос без изменений и записывает, какие части схемы он затронул.
      </p>

      <ol className="mt-6 flex flex-col gap-6">
        <li>
          <h2 className="font-semibold">1. Замените адрес GraphQL в тестах</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {targets.data.map((t) => (
              <li
                key={t.name}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface p-3"
              >
                <span
                  className={`size-2.5 rounded-full ${t.error ? 'bg-danger' : 'bg-covered'}`}
                  aria-label={t.error ? 'схема недоступна' : 'схема загружена'}
                />
                <div className="min-w-0 flex-1">
                  <Mono className="break-all">{`${proxy}${t.proxyPath}`}</Mono>
                  <div className="text-xs text-muted">
                    вместо <Mono className="text-xs">{t.url}</Mono>
                    {t.schema
                      ? `, схема загружена ${dateTime(t.schema.loadedAt)} (${t.schema.source})`
                      : ''}
                  </div>
                  {t.error && (
                    <div className="mt-1 text-xs text-danger">
                      {t.error.message}
                      {t.error.hint && <span className="block text-muted">{t.error.hint}</span>}
                    </div>
                  )}
                </div>
                <CopyButton label="Адрес" text={`${proxy}${t.proxyPath}`} />
              </li>
            ))}
          </ul>
        </li>
        <li>
          <h2 className="font-semibold">2. По желанию добавьте заголовки</h2>
          <p className="mt-1 text-muted">
            Без них покрытие тоже считается. Заголовки <Mono>X-Coverage-*</Mono> вырезаются до
            отправки на backend.
          </p>
          <dl className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
            {HEADERS.map(([h, d]) => (
              <div
                key={h}
                className="grid gap-1 border-b border-line px-3 py-2 last:border-0 sm:grid-cols-[18rem_1fr]"
              >
                <dt>
                  <Mono>{h}</Mono>
                </dt>
                <dd className="text-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </li>
        <li>
          <h2 className="font-semibold">3. Пример для вашего стека</h2>
          <div className="mt-3 flex flex-wrap gap-1" role="tablist" aria-label="Пример">
            {list.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={x.id === current.id}
                onClick={() => setTab(x.id)}
                className={`rounded-md px-3 py-1.5 ${x.id === current.id ? 'bg-surface-2 font-medium text-ink ring-1 ring-line' : 'text-muted hover:text-ink'}`}
              >
                {x.label}
              </button>
            ))}
          </div>
          <div className="mt-3">
            <QueryView text={current.code} />
          </div>
          <div className="mt-2">
            <CopyButton label="Скопировать пример" text={current.code} />
          </div>
        </li>
      </ol>
    </div>
  );
}
