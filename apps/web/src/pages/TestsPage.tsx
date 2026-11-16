import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { NeedRun } from '../components/Layout';
import { Empty, ErrorBox, Loading, Mono, Select } from '../components/ui';
import { api, type ImpactReport, type TestImpact } from '../lib/api';
import { plural } from '../lib/format';
import { LIVE_INTERVAL_MS, useRunLive } from '../lib/live';
import { useParam, useRunLink } from '../lib/url';

const testLabel = (t: TestImpact) => (t.unnamed ? 'без имени (нет X-Test-Name)' : t.name);

function Verdict({ t }: { t: TestImpact }) {
  if (t.empty)
    return (
      <span className="rounded px-1.5 py-0.5 text-xs text-muted ring-1 ring-line">
        не покрывает полей
      </span>
    );
  if (t.redundant)
    return (
      <span className="rounded bg-partial-soft px-1.5 py-0.5 text-xs text-partial">
        дублирует другие
      </span>
    );
  return (
    <span className="rounded bg-covered-soft px-1.5 py-0.5 text-xs text-covered">
      незаменим: {t.unique.length} {plural(t.unique.length, 'поле', 'поля', 'полей')}
    </span>
  );
}

/** Diminishing returns: covered fields after each test of the minimal set. */
function Saturation({ r }: { r: ImpactReport }) {
  const pts = [0, ...r.minimalSet.cumulative];
  const w = 520;
  const h = 140;
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const max = Math.max(r.totalFields, 1);
  const x = (i: number) => pad.l + (i / Math.max(pts.length - 1, 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-auto w-full max-w-xl"
      role="img"
      aria-label={`Покрытие полей растёт с каждым тестом минимального набора до ${r.coveredFields} из ${r.totalFields}`}
    >
      {[0, Math.round(max / 2), max].map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
            {t}
          </text>
        </g>
      ))}
      <path
        d={`${line} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`}
        fill="var(--accent-soft)"
      />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {pts.slice(1).map((v, i) => (
        <circle key={i} cx={x(i + 1)} cy={y(v)} r="2.5" fill="var(--accent)" />
      ))}
      <text x={pad.l} y={h - 4} fontSize="11" fill="var(--muted)">
        0 тестов
      </text>
      <text x={w - pad.r} y={h - 4} textAnchor="end" fontSize="11" fill="var(--muted)">
        {r.minimalSet.testKeys.length}{' '}
        {plural(r.minimalSet.testKeys.length, 'тест', 'теста', 'тестов')}
      </text>
    </svg>
  );
}

export function TestsPage() {
  const [run] = useParam('run');
  const [view, setView] = useParam('view');
  const link = useRunLink();
  const [open, setOpen] = useState<string | null>(null);
  const live = useRunLive(run);
  const q = useQuery({
    queryKey: ['impact', run],
    queryFn: () => api<ImpactReport>(`/api/runs/${encodeURIComponent(run)}/impact`),
    enabled: !!run,
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
  if (!run) return <NeedRun />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading what="вклад тестов" />;
  const r = q.data;
  const named = r.tests.length;
  const minimal = r.minimalSet.testKeys.length;
  const rows = r.tests.filter((t) =>
    view === 'redundant'
      ? t.redundant
      : view === 'essential'
        ? t.unique.length > 0
        : view === 'empty'
          ? t.empty
          : true,
  );

  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1 className="text-xl font-semibold">Вклад тестов</h1>
      {named === 0 ? (
        <Empty title="В прогоне нет запросов">Запустите тесты через прокси.</Empty>
      ) : (
        <>
          <section className="mt-4 grid gap-6 rounded-lg border border-line bg-surface p-5 md:grid-cols-[minmax(0,20rem)_1fr]">
            <div className="flex flex-col gap-3">
              <p>
                <b className="text-2xl font-semibold tabular-nums">{minimal}</b>{' '}
                <span className="text-muted">
                  из {named} {plural(named, 'теста', 'тестов', 'тестов')} дают то же покрытие полей
                  ({r.coveredFields} из {r.totalFields}).
                </span>
              </p>
              <ul className="flex flex-col gap-1.5 text-muted">
                <li>
                  <b className="text-partial tabular-nums">{r.redundant}</b>{' '}
                  {plural(
                    r.redundant,
                    'тест полностью дублирует',
                    'теста полностью дублируют',
                    'тестов полностью дублируют',
                  )}{' '}
                  другие по полям. Их можно сократить или направить на непокрытое.
                </li>
                {r.empty > 0 && (
                  <li>
                    <b className="tabular-nums text-ink">{r.empty}</b>{' '}
                    {plural(
                      r.empty,
                      'тест не покрывает',
                      'теста не покрывают',
                      'тестов не покрывают',
                    )}{' '}
                    ни одного поля схемы (только __typename или introspection).
                  </li>
                )}
                <li>
                  Дублирование считается по полям. Тесты могут отличаться аргументами и данными,
                  поэтому удалять их стоит после просмотра.
                </li>
              </ul>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted">
                Сколько полей покрывают тесты минимального набора, по нарастающей
              </div>
              <Saturation r={r} />
            </div>
          </section>

          <div className="mt-6 flex flex-wrap items-end gap-3">
            <h2 className="mr-auto text-base font-semibold">Тесты по уникальному вкладу</h2>
            <Select
              label="Показать"
              value={view}
              onChange={setView}
              options={[
                { value: 'essential', label: 'незаменимые' },
                { value: 'redundant', label: 'дублирующие' },
                { value: 'empty', label: 'без полей' },
              ]}
            />
          </div>
          <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-left">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Тест</th>
                  <th className="px-3 py-2 text-right font-medium">Запросов</th>
                  <th className="px-3 py-2 text-right font-medium">Полей</th>
                  <th className="w-48 px-3 py-2 font-medium">Только этот тест</th>
                  <th className="px-3 py-2 font-medium">Вывод</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const share = t.fields ? (t.unique.length / t.fields) * 100 : 0;
                  return (
                    <Fragment key={t.testKey}>
                      <tr className="border-b border-line last:border-0 hover:bg-surface-2">
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            className="text-left hover:underline disabled:no-underline"
                            disabled={!t.unique.length}
                            aria-expanded={open === t.testKey}
                            onClick={() => setOpen(open === t.testKey ? null : t.testKey)}
                          >
                            <span className={t.unnamed ? 'text-muted' : 'font-medium'}>
                              {testLabel(t)}
                            </span>
                          </button>
                          {t.suite && <div className="text-xs text-muted">{t.suite}</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{t.requests || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{t.fields}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="w-6 text-right tabular-nums">{t.unique.length}</span>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-uncovered-soft">
                              <div className="h-full bg-covered" style={{ width: `${share}%` }} />
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Verdict t={t} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          {!t.empty && (
                            <Link
                              to={link('/graph', { test: t.testKey })}
                              className="whitespace-nowrap text-accent hover:underline"
                            >
                              след на карте
                            </Link>
                          )}
                        </td>
                      </tr>
                      {open === t.testKey && (
                        <tr className="border-b border-line bg-surface-2">
                          <td colSpan={6} className="px-3 py-3">
                            <div className="mb-1 text-xs text-muted">
                              Покрывает только этот тест: если его удалить, покрытие этих полей
                              пропадёт
                            </div>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {t.unique.map((f) => (
                                <Link key={f} to={link(`/fields/${f}`)} className="hover:underline">
                                  <Mono>{f}</Mono>
                                </Link>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
