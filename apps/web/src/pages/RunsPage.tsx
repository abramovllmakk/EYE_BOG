import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Empty, ErrorBox, Loading, Select, TextInput, Bar } from '../components/ui';
import { api, qs, type Filters, type Run, type Target, type TimelinePoint } from '../lib/api';
import { dateTime, pct } from '../lib/format';
import { useParam } from '../lib/url';

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-xs text-muted">мало точек</span>;
  const w = 120;
  const h = 28;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / 100) * (h - 4) - 2}`)
    .join(' ');
  return (
    <svg
      width={w}
      height={h}
      role="img"
      aria-label={`Тренд покрытия полей: ${values.map((v) => pct(v)).join(', ')}`}
    >
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <circle
        cx={w}
        cy={h - (values[values.length - 1]! / 100) * (h - 4) - 2}
        r="2.5"
        fill="var(--accent)"
      />
    </svg>
  );
}

function Onboarding() {
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => api<Target[]>('/api/targets') });
  const proxy = `${location.protocol}//${location.hostname}:4000`;
  return (
    <Empty title="Прогонов пока нет">
      <p>Направьте автотесты на прокси вместо настоящего API, больше ничего менять не нужно:</p>
      <pre className="mt-3 overflow-auto rounded-md bg-surface-2 p-3 text-left font-mono text-xs text-ink">
        {(targets.data ?? []).map((t) => `${proxy}${t.proxyPath}   →   ${t.url}`).join('\n') ||
          `${proxy}/graphql`}
      </pre>
      <p className="mt-3">
        Необязательно: заголовки X-Test-Name и X-Test-Suite подпишут запросы именами тестов.
      </p>
      {targets.data?.some((t) => t.error) && (
        <div className="mt-3 rounded-md border border-danger/40 p-3 text-left">
          {targets.data
            .filter((t) => t.error)
            .map((t) => (
              <p key={t.name}>
                <b>{t.name}:</b> {t.error!.message}
                {t.error!.hint && <span className="block text-muted">{t.error!.hint}</span>}
              </p>
            ))}
        </div>
      )}
    </Empty>
  );
}

export function RunsPage() {
  const [environment, setEnv] = useParam('env');
  const [branch, setBranch] = useParam('branch');
  const [team, setTeam] = useParam('team');
  const [testSuite, setSuite] = useParam('suite');
  const [status, setStatus] = useParam('status');
  const [from, setFrom] = useParam('from');
  const [to, setTo] = useParam('to');
  const filters = {
    environment,
    branch,
    team,
    testSuite,
    status,
    from,
    to: to ? `${to}T23:59:59` : '',
  };
  const runs = useQuery({
    queryKey: ['runs', filters],
    queryFn: () =>
      api<{ items: Run[]; total: number }>(`/api/runs${qs({ ...filters, limit: 100 })}`),
    refetchInterval: 5000,
  });
  const trend = useQuery({
    queryKey: ['timeline', filters],
    queryFn: () => api<TimelinePoint[]>(`/api/timeline${qs({ ...filters, limit: 30 })}`),
  });
  const options = useQuery({ queryKey: ['filters'], queryFn: () => api<Filters>('/api/filters') });
  const o = options.data;
  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-xl font-semibold">Прогоны тестов</h1>
        <Select
          label="Окружение"
          value={environment}
          onChange={setEnv}
          options={o?.environments ?? []}
        />
        <Select label="Ветка" value={branch} onChange={setBranch} options={o?.branches ?? []} />
        <Select label="Команда" value={team} onChange={setTeam} options={o?.teams ?? []} />
        <Select
          label="Набор тестов"
          value={testSuite}
          onChange={setSuite}
          options={o?.testSuites ?? []}
        />
        <Select
          label="Статус"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'running', label: 'идёт' },
            { value: 'finished', label: 'завершён' },
          ]}
        />
        <TextInput label="С даты" type="date" value={from} onChange={setFrom} />
        <TextInput label="По дату" type="date" value={to} onChange={setTo} />
        <div className="flex flex-col gap-1 text-xs text-muted">
          Тренд полей
          <Sparkline values={(trend.data ?? []).map((p) => p.summary.fields)} />
        </div>
      </div>
      {runs.error && <ErrorBox error={runs.error} />}
      {runs.isLoading && <Loading what="прогоны" />}
      {runs.data &&
        runs.data.items.length === 0 &&
        (Object.values(filters).some(Boolean) ? (
          <Empty title="Нет прогонов под эти фильтры">Сбросьте часть фильтров.</Empty>
        ) : (
          <Onboarding />
        ))}
      {runs.data && runs.data.items.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Прогон</th>
                <th className="px-3 py-2 font-medium">Начат</th>
                <th className="px-3 py-2 font-medium">Запросов</th>
                <th className="w-40 px-3 py-2 font-medium">Поля</th>
                <th className="px-3 py-2 font-medium">Типы</th>
                <th className="px-3 py-2 font-medium">Операции</th>
                <th className="px-3 py-2 font-medium">Аргументы</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="px-3 py-2">
                    <Link
                      to={`/graph?run=${encodeURIComponent(r.id)}`}
                      className="font-medium hover:underline"
                    >
                      {r.branch ?? r.id.slice(0, 8)}
                    </Link>
                    <div className="text-xs text-muted">
                      {[
                        r.environment,
                        r.buildId && `сборка ${r.buildId}`,
                        r.team,
                        r.testSuite,
                        r.status === 'running' ? 'идёт' : null,
                      ]
                        .filter(Boolean)
                        .join(', ') || r.id}
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{dateTime(r.startedAt)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {r.requests.total}
                    {r.requests.invalid > 0 && (
                      <span className="text-danger" title="невалидных">
                        {' '}
                        ({r.requests.invalid} невалид.)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="tabular-nums">{pct(r.summary?.fields)}</div>
                    {r.summary && <Bar value={r.summary.fields} className="mt-1" />}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{pct(r.summary?.types)}</td>
                  <td className="px-3 py-2 tabular-nums">{pct(r.summary?.operations)}</td>
                  <td className="px-3 py-2 tabular-nums">{pct(r.summary?.arguments)}</td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      to={`/table?run=${encodeURIComponent(r.id)}`}
                      className="text-accent hover:underline"
                    >
                      таблица
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
