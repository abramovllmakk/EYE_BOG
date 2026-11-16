import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { NeedRun } from '../components/Layout';
import { Bar, Empty, ErrorBox, Loading, Mono, Select, TextInput } from '../components/ui';
import {
  api,
  qs,
  type Compare,
  type CoverageSummary,
  type Filters,
  type Operation,
  type Run,
  type TimelinePoint,
  type TypeCoverage,
  type TeamCoverage,
} from '../lib/api';
import { ANALYSIS_LABEL, dateTime, pct, plural, runLabel } from '../lib/format';
import { useParam, useRunLink } from '../lib/url';
import { OperationList } from './DetailPages';

export function OperationsPage() {
  const [run] = useParam('run');
  const [test, setTest] = useParam('test');
  const [status, setStatus] = useParam('status');
  const [search, setSearch] = useParam('q');
  const [page, setPage] = useParam('page', '0');
  const link = useRunLink();
  const tests = useQuery({
    queryKey: ['tests', run],
    queryFn: () =>
      api<
        { testKey: string; name: string; suite: string | null; requests: number; fields: number }[]
      >(`/api/runs/${run}/tests`),
    enabled: !!run,
  });
  const ops = useQuery({
    queryKey: ['ops', run, test, status, search, page],
    queryFn: () =>
      api<{ items: Operation[]; total: number }>(
        `/api/runs/${run}/operations${qs({ test, status, search, limit: 50, offset: Number(page) * 50 })}`,
      ),
    enabled: !!run,
  });
  if (!run) return <NeedRun />;
  const names = [...new Set((tests.data ?? []).map((t) => t.name))];
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-xl font-semibold">Журнал запросов</h1>
        <TextInput label="Операция или тест" value={search} onChange={setSearch} />
        <Select label="Тест" value={test} onChange={setTest} options={names} />
        <Select
          label="Анализ"
          value={status}
          onChange={setStatus}
          options={Object.entries(ANALYSIS_LABEL).map(([value, label]) => ({ value, label }))}
        />
      </div>
      {tests.data && tests.data.length > 0 && (
        <p className="mt-3 text-muted">
          {tests.data.length} {plural(tests.data.length, 'тест', 'теста', 'тестов')} в прогоне. Что
          даёт каждый из них и какие дублируют друг друга, смотрите в разделе{' '}
          <Link to={link('/tests')} className="text-accent hover:underline">
            «Вклад тестов»
          </Link>
          .
        </p>
      )}
      <div className="mt-4">
        {ops.error && <ErrorBox error={ops.error} />}
        {ops.data ? <OperationList items={ops.data.items} /> : <Loading what="запросы" />}
      </div>
      {ops.data && ops.data.total > 50 && (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            disabled={page === '0'}
            onClick={() => setPage(String(Number(page) - 1))}
            className="rounded-md border border-line px-3 py-1 disabled:opacity-40"
          >
            Назад
          </button>
          <span className="tabular-nums text-muted">
            {Number(page) * 50 + 1}–{Math.min((Number(page) + 1) * 50, ops.data.total)} из{' '}
            {ops.data.total}
          </span>
          <button
            type="button"
            disabled={(Number(page) + 1) * 50 >= ops.data.total}
            onClick={() => setPage(String(Number(page) + 1))}
            className="rounded-md border border-line px-3 py-1 disabled:opacity-40"
          >
            Дальше
          </button>
        </div>
      )}
    </div>
  );
}

export function HeatmapPage() {
  const [run] = useParam('run');
  const [scale, setScale] = useParam('scale', 'log');
  const link = useRunLink();
  const cov = useQuery({
    queryKey: ['coverage', run],
    queryFn: () =>
      api<{ summary: CoverageSummary; types: TypeCoverage[] }>(`/api/runs/${run}/coverage`),
    enabled: !!run,
  });
  const types = useMemo(
    () =>
      (cov.data?.types ?? [])
        .filter((t) => t.fields.length > 0)
        .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)),
    [cov.data],
  );
  const max = Math.max(1, ...types.flatMap((t) => t.fields.map((f) => f.requests)));
  if (!run) return <NeedRun />;
  if (cov.error) return <ErrorBox error={cov.error} />;
  if (!cov.data) return <Loading what="покрытие" />;
  const intensity = (n: number) =>
    n === 0 ? 0 : scale === 'log' ? Math.log(n + 1) / Math.log(max + 1) : n / max;
  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="mr-auto text-xl font-semibold">Интенсивность обращений к полям</h1>
        <Select
          label="Шкала"
          value={scale}
          onChange={setScale}
          placeholder={null}
          options={[
            { value: 'log', label: 'логарифмическая' },
            { value: 'linear', label: 'линейная' },
          ]}
        />
        <div className="flex items-center gap-2 text-xs text-muted">
          0
          <div
            className="h-3 w-32 rounded"
            style={{ background: 'linear-gradient(90deg, var(--uncovered-soft), var(--accent))' }}
          />
          {max} запросов
        </div>
      </div>
      <div
        className="mt-5 grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
      >
        {types.map((t) => (
          <section key={t.name} className="rounded-lg border border-line bg-surface p-3">
            <Link to={link(`/types/${t.name}`)} className="font-semibold hover:underline">
              {t.name}
            </Link>
            <ul className="mt-2 flex flex-wrap gap-1">
              {t.fields.map((f) => (
                <li key={f.name}>
                  <Link
                    to={link(`/fields/${f.coordinate}`)}
                    title={`${f.coordinate}: ${f.requests} запросов`}
                    className="block rounded px-1.5 py-0.5 font-mono text-xs"
                    style={{
                      background: f.requests
                        ? `color-mix(in srgb, var(--accent) ${Math.round(15 + intensity(f.requests) * 85)}%, var(--surface))`
                        : 'var(--uncovered-soft)',
                      color: intensity(f.requests) > 0.55 ? 'var(--on-accent)' : 'var(--ink)',
                    }}
                  >
                    {f.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

const SUMMARY_KEYS: [keyof Compare['delta'], string][] = [
  ['fields', 'Поля'],
  ['types', 'Типы'],
  ['operations', 'Операции'],
  ['arguments', 'Аргументы'],
  ['enumValues', 'Enum'],
  ['inputFields', 'Input'],
  ['edges', 'Связи'],
];

export function ComparePage() {
  const [base, setBase] = useParam('base');
  const [head, setHead] = useParam('head');
  const link = useRunLink();
  const runs = useQuery({
    queryKey: ['runs', 'compare'],
    queryFn: () => api<{ items: Run[] }>('/api/runs?limit=200'),
  });
  const cmp = useQuery({
    queryKey: ['compare', base, head],
    queryFn: () => api<Compare>(`/api/compare${qs({ base, head })}`),
    enabled: !!base && !!head,
  });
  const options = (runs.data?.items ?? []).map((r) => ({
    value: r.id,
    label: `${runLabel(r)} (${dateTime(r.startedAt)})`,
  }));
  // Sensible default: the selected run (or the newest one) against the latest earlier main run.
  const [current] = useParam('run');
  const [, setParams] = useSearchParams();
  useEffect(() => {
    if (base || head || !runs.data?.items.length) return;
    const items = runs.data.items;
    const h = items.find((r) => r.id === current) ?? items[0]!;
    const b =
      items.find((r) => r.id !== h.id && r.branch === 'main' && r.startedAt <= h.startedAt) ??
      items.find((r) => r.id !== h.id && r.startedAt <= h.startedAt);
    // One URL update: two separate setters in the same tick would overwrite each other.
    if (b)
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('base', b.id);
          next.set('head', h.id);
          return next;
        },
        { replace: true },
      );
  }, [runs.data, base, head, current, setParams]);
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-xl font-semibold">Сравнение прогонов</h1>
        <Select
          label="Было (base)"
          value={base}
          onChange={setBase}
          options={options}
          placeholder="выберите"
        />
        <Select
          label="Стало (head)"
          value={head}
          onChange={setHead}
          options={options}
          placeholder="выберите"
        />
      </div>
      {(!base || !head) && (
        <Empty title="Выберите два прогона">
          Например, прогон main и прогон ветки с новыми тестами.
        </Empty>
      )}
      {cmp.error && <ErrorBox error={cmp.error} />}
      {cmp.data && (
        <>
          <div
            className={`mt-5 rounded-lg border p-4 ${cmp.data.lost.length ? 'border-danger/50 bg-danger/5' : 'border-covered/50 bg-covered-soft/40'}`}
            role="status"
          >
            <div className="font-semibold">
              {cmp.data.lost.length
                ? `Регрессия покрытия: потеряно ${cmp.data.lost.length} ${plural(cmp.data.lost.length, 'поле', 'поля', 'полей')}`
                : cmp.data.newlyCovered.length
                  ? `Покрытие выросло: +${cmp.data.newlyCovered.length} ${plural(cmp.data.newlyCovered.length, 'поле', 'поля', 'полей')}, потерь нет`
                  : 'Покрытие полей не изменилось'}
            </div>
            <div className="mt-1 text-muted">
              Поля: {pct(cmp.data.base.summary.fields)} → {pct(cmp.data.head.summary.fields)}
              {cmp.data.lost.length > 0 &&
                '. Потерянные поля раньше проверялись тестами, а в новом прогоне нет: проверьте, не удалён ли тест.'}
            </div>
          </div>
          <div className="mt-5 overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-left tabular-nums">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Метрика</th>
                  <th className="px-3 py-2 font-medium">Было</th>
                  <th className="px-3 py-2 font-medium">Стало</th>
                  <th className="px-3 py-2 font-medium">Изменение</th>
                </tr>
              </thead>
              <tbody>
                {SUMMARY_KEYS.map(([k, l]) => {
                  const d = cmp.data.delta[k];
                  return (
                    <tr key={k} className="border-b border-line last:border-0">
                      <td className="px-3 py-1.5">{l}</td>
                      <td className="px-3 py-1.5">{pct(cmp.data.base.summary[k])}</td>
                      <td className="px-3 py-1.5">{pct(cmp.data.head.summary[k])}</td>
                      <td
                        className={`px-3 py-1.5 font-medium ${d > 0 ? 'text-covered' : d < 0 ? 'text-danger' : 'text-muted'}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-20">
                            {d > 0 ? '+' : ''}
                            {d.toFixed(1)} п.п.
                          </span>
                          <span
                            className="relative h-1.5 w-40 rounded-full bg-uncovered-soft"
                            aria-hidden
                          >
                            <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
                            <span
                              className={`absolute inset-y-0 rounded-full ${d >= 0 ? 'left-1/2 bg-covered' : 'right-1/2 bg-danger'}`}
                              style={{ width: `${Math.min(Math.abs(d), 50)}%` }}
                            />
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            {[
              ['Стали покрыты', cmp.data.newlyCovered, 'text-covered'],
              ['Потеряно покрытие', cmp.data.lost, 'text-danger'],
            ].map(([title, list, cls]) => (
              <section key={title as string}>
                <h2 className={`mb-2 font-semibold ${cls as string}`}>
                  {title as string} ({(list as string[]).length})
                </h2>
                <ul className="max-h-96 overflow-auto rounded-lg border border-line bg-surface p-2">
                  {(list as string[]).map((c) => (
                    <li key={c}>
                      <Link to={link(`/fields/${c}`, { run: head })} className="hover:underline">
                        <Mono>{c}</Mono>
                      </Link>
                    </li>
                  ))}
                  {(list as string[]).length === 0 && <li className="text-muted">нет</li>}
                </ul>
              </section>
            ))}
          </div>
          {cmp.data.schemaDiff ? (
            <section className="mt-6">
              <h2 className="mb-2 font-semibold">Схема изменилась между прогонами</h2>
              <p className="text-muted">
                Добавлено: {cmp.data.schemaDiff.added.length} координат (
                {cmp.data.schemaDiff.addedTypes.join(', ') || 'без новых типов'}), удалено:{' '}
                {cmp.data.schemaDiff.removed.length}.
              </p>
              <div className="mt-2 grid gap-4 md:grid-cols-2 font-mono text-[13px]">
                <ul className="rounded-lg border border-line bg-surface p-2">
                  {cmp.data.schemaDiff.added.map((c) => (
                    <li key={c} className="text-covered">
                      + {c}
                    </li>
                  ))}
                </ul>
                <ul className="rounded-lg border border-line bg-surface p-2">
                  {cmp.data.schemaDiff.removed.map((c) => (
                    <li key={c} className="text-danger">
                      − {c}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : (
            <p className="mt-6 text-muted">Оба прогона на одной версии схемы.</p>
          )}
        </>
      )}
    </div>
  );
}

const SERIES: [keyof TimelinePoint['summary'], string, string][] = [
  ['fields', 'Поля', 'var(--accent)'],
  ['operations', 'Операции', 'var(--covered)'],
  ['types', 'Типы', 'var(--partial)'],
];

export function TimelinePage() {
  const [branch, setBranch] = useParam('branch');
  const [environment, setEnv] = useParam('env');
  const [target, setTarget] = useParam('target');
  const link = useRunLink();
  const filters = useQuery({ queryKey: ['filters'], queryFn: () => api<Filters>('/api/filters') });
  const tl = useQuery({
    queryKey: ['timeline', branch, environment, target],
    queryFn: () =>
      api<TimelinePoint[]>(`/api/timeline${qs({ branch, environment, target, limit: 200 })}`),
  });
  const pts = tl.data ?? [];
  const W = 900;
  const H = 280;
  const P = 36;
  // X follows real time, so gaps between runs are visible.
  const t0 = pts[0]?.startedAt ?? 0;
  const span = Math.max((pts.at(-1)?.startedAt ?? 0) - t0, 1);
  const x = (i: number) =>
    P + (pts.length < 2 ? (W - 2 * P) / 2 : ((pts[i]!.startedAt - t0) / span) * (W - 2 * P));
  const y = (v: number) => H - P - (v / 100) * (H - 2 * P);
  const days = new Map<string, number>();
  pts.forEach((p, i) => {
    const d = new Date(p.startedAt).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
    });
    if (!days.has(d)) days.set(d, i);
  });
  const first = pts[0];
  const last = pts.at(-1);
  const delta = first && last ? last.summary.fields - first.summary.fields : 0;
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-xl font-semibold">Динамика покрытия по прогонам</h1>
        <Select
          label="Ветка"
          value={branch}
          onChange={setBranch}
          options={filters.data?.branches ?? []}
        />
        <Select
          label="Окружение"
          value={environment}
          onChange={setEnv}
          options={filters.data?.environments ?? []}
        />
        <Select
          label="Цель"
          value={target}
          onChange={setTarget}
          options={filters.data?.targets ?? []}
        />
      </div>
      {tl.error && <ErrorBox error={tl.error} />}
      {tl.data && pts.length === 0 && <Empty title="Нет прогонов под фильтр" />}
      {first && last && pts.length > 1 && (
        <p className="mt-4 text-muted">
          С {dateTime(first.startedAt)} по {dateTime(last.startedAt)} ({pts.length} прогонов)
          покрытие полей изменилось с <b className="text-ink">{pct(first.summary.fields)}</b> до{' '}
          <b className="text-ink">{pct(last.summary.fields)}</b>{' '}
          <span className={delta > 0 ? 'text-covered' : delta < 0 ? 'text-danger' : ''}>
            ({delta > 0 ? '+' : ''}
            {delta.toFixed(1)} п.п.)
          </span>
          .
        </p>
      )}
      {pts.length > 0 && (
        <figure className="mt-4 rounded-lg border border-line bg-surface p-4">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            role="img"
            aria-label="График процента покрытия по прогонам"
          >
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line x1={P} x2={W - P} y1={y(v)} y2={y(v)} stroke="var(--line)" />
                <text x={P - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
                  {v}%
                </text>
              </g>
            ))}
            {[...days].map(([label, i]) => (
              <text
                key={label}
                x={x(i)}
                y={H - P + 18}
                textAnchor="middle"
                fontSize="11"
                fill="var(--muted)"
              >
                {label}
              </text>
            ))}
            {SERIES.map(([k, , color]) => (
              <g key={k}>
                <polyline
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  points={pts.map((p, i) => `${x(i)},${y(p.summary[k])}`).join(' ')}
                />
                {pts.map((p, i) => (
                  <circle key={p.runId} cx={x(i)} cy={y(p.summary[k])} r="3" fill={color}>
                    <title>{`${runLabel({ id: p.runId, branch: p.branch, environment: p.environment, buildId: p.buildId, startedAt: p.startedAt })}: ${pct(p.summary[k])}`}</title>
                  </circle>
                ))}
              </g>
            ))}
          </svg>
          <figcaption className="mt-2 flex gap-4 text-xs text-muted">
            {SERIES.map(([k, l, c]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-4" style={{ background: c }} />
                {l}
              </span>
            ))}
          </figcaption>
        </figure>
      )}
      {pts.length > 0 && (
        <ol className="mt-4 text-sm">
          {[...pts].reverse().map((p) => (
            <li key={p.runId} className="flex gap-3 border-b border-line py-1">
              <span className="w-32 tabular-nums text-muted">{dateTime(p.startedAt)}</span>
              <Link to={link('/graph', { run: p.runId })} className="hover:underline">
                {runLabel({
                  id: p.runId,
                  branch: p.branch,
                  environment: p.environment,
                  buildId: p.buildId,
                  startedAt: p.startedAt,
                })}
              </Link>
              <span className="ml-auto tabular-nums">
                поля {pct(p.summary.fields)}, операции {pct(p.summary.operations)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Coverage of each team = union of all its runs (within the filters). */
export function TeamsPage() {
  const [environment, setEnv] = useParam('env');
  const [branch, setBranch] = useParam('branch');
  const [from, setFrom] = useParam('from');
  const [to, setTo] = useParam('to');
  const filters = useQuery({ queryKey: ['filters'], queryFn: () => api<Filters>('/api/filters') });
  const params = { environment, branch, from, to: to ? `${to}T23:59:59` : '' };
  const teams = useQuery({
    queryKey: ['teams', params],
    queryFn: () => api<TeamCoverage[]>(`/api/teams${qs(params)}`),
  });
  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold">Покрытие по командам</h1>
          <p className="mt-1 max-w-prose text-muted">
            Все прогоны команды вместе: поле считается покрытым, если его проверил хотя бы один
            прогон этой команды. Команда берётся из заголовка X-Coverage-Team или из gqlcov run
            start --team.
          </p>
        </div>
        <Select
          label="Окружение"
          value={environment}
          onChange={setEnv}
          options={filters.data?.environments ?? []}
        />
        <Select
          label="Ветка"
          value={branch}
          onChange={setBranch}
          options={filters.data?.branches ?? []}
        />
        <TextInput label="С даты" type="date" value={from} onChange={setFrom} />
        <TextInput label="По дату" type="date" value={to} onChange={setTo} />
      </div>
      {teams.error && <ErrorBox error={teams.error} />}
      {teams.isLoading && <Loading what="команды" />}
      {teams.data && teams.data.length === 0 && <Empty title="Нет прогонов под эти фильтры" />}
      {teams.data && teams.data.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Команда</th>
                <th className="px-3 py-2 font-medium">Сервер</th>
                <th className="px-3 py-2 font-medium">Прогонов</th>
                <th className="px-3 py-2 font-medium">Последний</th>
                <th className="w-40 px-3 py-2 font-medium">Поля</th>
                <th className="px-3 py-2 font-medium">Операции</th>
                <th className="px-3 py-2 font-medium">Типы</th>
                <th className="px-3 py-2 font-medium">Аргументы</th>
                <th className="px-3 py-2 font-medium">Не вызваны</th>
              </tr>
            </thead>
            <tbody>
              {teams.data.map((t) => (
                <tr
                  key={`${t.team}|${t.target}`}
                  className="border-b border-line align-top last:border-0 hover:bg-surface-2"
                >
                  <td className="px-3 py-2 font-medium">
                    {t.team ? (
                      <Link to={`/?team=${encodeURIComponent(t.team)}`} className="hover:underline">
                        {t.team}
                      </Link>
                    ) : (
                      <span className="text-muted">без команды</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{t.target}</td>
                  <td className="px-3 py-2 tabular-nums">{t.runs}</td>
                  <td className="px-3 py-2 tabular-nums">{dateTime(t.lastRunAt)}</td>
                  <td className="px-3 py-2">
                    <div className="tabular-nums">{pct(t.summary.fields)}</div>
                    <Bar value={t.summary.fields} className="mt-1" />
                  </td>
                  <td className="px-3 py-2 tabular-nums">{pct(t.summary.operations)}</td>
                  <td className="px-3 py-2 tabular-nums">{pct(t.summary.types)}</td>
                  <td className="px-3 py-2 tabular-nums">{pct(t.summary.arguments)}</td>
                  <td className="px-3 py-2 text-xs">
                    {t.uncovered.operations.length === 0 ? (
                      <span className="text-muted">все вызваны</span>
                    ) : (
                      <details>
                        <summary className="cursor-pointer">
                          {t.uncovered.operations.length} операций
                        </summary>
                        <ul className="mt-1 font-mono">
                          {t.uncovered.operations.map((o) => (
                            <li key={o}>{o}</li>
                          ))}
                        </ul>
                      </details>
                    )}
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
