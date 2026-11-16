import { useState } from 'react';
import { Link } from 'react-router';
import { GapQuery } from '../components/GapQuery';
import { NeedRun } from '../components/Layout';
import { Empty, ErrorBox, Loading, Mono, Select } from '../components/ui';
import type { GapPlan } from '../lib/api';
import { pct, plural } from '../lib/format';
import { usePlan } from '../lib/plan';
import { useParam, useRunLink } from '../lib/url';

const OP_LABEL: Record<string, string> = {
  query: 'query',
  mutation: 'mutation',
  subscription: 'subscription',
};

/** Cumulative field coverage after each suggestion, as a step chart. */
function Projection({ plan }: { plan: GapPlan }) {
  const w = 640;
  const h = 150;
  const pad = { l: 36, r: 12, t: 12, b: 22 };
  const pts = [plan.fields.percent, ...plan.suggestions.map((s) => s.coverageAfter)];
  const min = Math.max(0, Math.floor(Math.min(...pts) / 10) * 10 - 10);
  const x = (i: number) => pad.l + (i / Math.max(pts.length - 1, 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / (100 - min)) * (h - pad.t - pad.b);
  let d = `M${x(0)},${y(pts[0]!)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(i)} V${y(pts[i]!)}`;
  const ticks = [min, Math.round((min + 100) / 2), 100];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-auto w-full max-w-2xl"
      role="img"
      aria-label={`Покрытие полей вырастет с ${pct(plan.fields.percent)} до ${pct(plan.projected)} за ${plan.suggestions.length} ${plural(plan.suggestions.length, 'запрос', 'запроса', 'запросов')}`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={pad.l}
            x2={w - pad.r}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--line)"
            strokeWidth="1"
          />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
            {t}%
          </text>
        </g>
      ))}
      <path d={`${d} V${y(min)} H${x(0)} Z`} fill="var(--covered-soft)" />
      <path d={d} fill="none" stroke="var(--covered)" strokeWidth="2" />
      <circle cx={x(0)} cy={y(pts[0]!)} r="3.5" fill="var(--partial)" />
      <circle cx={x(pts.length - 1)} cy={y(pts.at(-1)!)} r="3.5" fill="var(--covered)" />
      <text x={pad.l} y={h - 4} fontSize="11" fill="var(--muted)">
        сейчас
      </text>
      <text x={w - pad.r} y={h - 4} textAnchor="end" fontSize="11" fill="var(--muted)">
        после {plan.suggestions.length}{' '}
        {plural(plan.suggestions.length, 'запроса', 'запросов', 'запросов')}
      </text>
    </svg>
  );
}

function downloadAll(plan: GapPlan) {
  const text = plan.suggestions
    .map(
      (s, i) =>
        `# ${i + 1}. +${s.marginalGain} ${plural(s.marginalGain, 'поле', 'поля', 'полей')} → ${s.coverageAfter}%\n# variables: ${JSON.stringify(s.variables)}\n${s.query}`,
    )
    .join('\n\n');
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'application/graphql' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'coverage-plan.graphql';
  a.click();
  URL.revokeObjectURL(url);
}

export function PlanPage() {
  const [run] = useParam('run');
  const [op, setOp] = useParam('op');
  const link = useRunLink();
  const { plan, proxyUrl } = usePlan(run);
  const [open, setOpen] = useState<Set<string> | null>(null);
  if (!run) return <NeedRun />;
  if (plan.error) return <ErrorBox error={plan.error} />;
  if (!plan.data) return <Loading what="план покрытия" />;
  const p = plan.data;
  const items = p.suggestions.filter((s) => !op || s.operationType === op);
  const isOpen = (id: string) => (open ? open.has(id) : id === items[0]?.id);
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur ?? (p.suggestions[0] ? [p.suggestions[0].id] : []));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-xl font-semibold">План покрытия</h1>
      {p.suggestions.length === 0 ? (
        <Empty title="Добавлять нечего">
          Все поля, до которых можно дойти от корня схемы, уже покрыты тестами этого прогона.
        </Empty>
      ) : (
        <>
          <section className="mt-4 grid gap-6 rounded-lg border border-line bg-surface p-5 md:grid-cols-[minmax(0,15rem)_1fr]">
            <div>
              <div className="flex items-baseline gap-2 tabular-nums">
                <span className="text-3xl font-semibold text-partial">{pct(p.fields.percent)}</span>
                <svg viewBox="0 0 24 12" className="h-3 w-6 text-muted" aria-hidden>
                  <path
                    d="M0 6h21M16 1l5 5-5 5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                </svg>
                <span className="text-3xl font-semibold text-covered">{pct(p.projected)}</span>
              </div>
              <p className="mt-2 text-muted">
                Столько полей схемы будет покрыто, если добавить в автотесты{' '}
                <b className="text-ink">{p.suggestions.length}</b>{' '}
                {plural(p.suggestions.length, 'запрос', 'запроса', 'запросов')} ниже. Сейчас не
                покрыто {p.fields.total - p.fields.covered} из {p.fields.total} полей.
              </p>
              <p className="mt-2 text-muted">
                Запросы собраны по схеме: путь от корня идёт через поля, которые тесты уже
                используют, а первыми стоят те, что закрывают больше всего полей.
              </p>
              <button
                type="button"
                onClick={() => downloadAll(p)}
                className="mt-4 h-9 whitespace-nowrap rounded-md bg-accent px-3 font-medium text-on-accent"
              >
                Скачать все запросы
              </button>
            </div>
            <Projection plan={p} />
          </section>

          <div className="mt-6 flex items-end gap-3">
            <h2 className="mr-auto text-base font-semibold">Запросы по порядку пользы</h2>
            <Select
              label="Тип операции"
              value={op}
              onChange={setOp}
              options={['query', 'mutation', 'subscription'].filter((k) =>
                p.suggestions.some((s) => s.operationType === k),
              )}
            />
          </div>
          <ol className="mt-3 flex flex-col gap-2">
            {items.map((s) => {
              const n = p.suggestions.indexOf(s) + 1;
              const expanded = isOpen(s.id);
              return (
                <li key={s.id} className="rounded-lg border border-line bg-surface">
                  <button
                    type="button"
                    onClick={() => toggle(s.id)}
                    aria-expanded={expanded}
                    className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-surface-2"
                  >
                    <span className="w-6 text-right tabular-nums text-muted">{n}</span>
                    <span className="min-w-0 flex-1">
                      <Mono className="font-medium">{s.operationName}</Mono>
                      <span className="ml-2 text-xs text-muted">
                        {OP_LABEL[s.operationType]}
                        {s.path.length > 0 && <>, через {s.path.join(' → ')}</>}
                      </span>
                    </span>
                    <span className="tabular-nums text-covered">+{s.marginalGain}</span>
                    <span className="w-16 text-right tabular-nums">{pct(s.coverageAfter)}</span>
                    <svg
                      viewBox="0 0 12 12"
                      className={`size-3 text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
                      aria-hidden
                    >
                      <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
                  {expanded && (
                    <div className="border-t border-line px-4 py-4">
                      <GapQuery s={s} proxyUrl={proxyUrl} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {p.unreachable.length > 0 && (
        <section className="mt-6 rounded-lg border border-dashed border-line p-4">
          <h2 className="text-sm font-semibold">До этих полей нельзя дойти от корня схемы</h2>
          <p className="mt-1 text-muted">
            Ни одно поле Query, Mutation или Subscription не ведёт к их типам, поэтому тест их не
            покроет. Возможно, это мёртвый код схемы.
          </p>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {p.unreachable.map((f) => (
              <Link key={f} to={link(`/fields/${f}`)} className="hover:underline">
                <Mono>{f}</Mono>
              </Link>
            ))}
          </p>
        </section>
      )}
    </div>
  );
}
