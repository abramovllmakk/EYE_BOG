import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type Insights } from '../lib/api';
import { plural } from '../lib/format';
import { Mono } from './ui';

interface Signal {
  key: string;
  tone: 'danger' | 'partial' | 'muted';
  count: number;
  title: string;
  hint: string;
  items: { label: string; to: string }[];
  action?: { label: string; to: string };
}

const toneClass = {
  danger: 'text-danger',
  partial: 'text-partial',
  muted: 'text-muted',
};

/** Risk signals of a run: what the percentages alone do not show. */
export function InsightsPanel({ run }: { run: string }) {
  const id = encodeURIComponent(run);
  const q = useQuery({
    queryKey: ['insights', run],
    queryFn: () => api<Insights>(`/api/runs/${id}/insights`),
  });
  if (!q.data) return null;
  const d = q.data;
  const field = (c: string) => ({ label: c, to: `/fields/${c}?run=${id}` });
  const candidates: Signal[] = [
    {
      key: 'deprecated',
      tone: 'danger',
      count: d.deprecatedInUse.length,
      title: `${plural(d.deprecatedInUse.length, 'устаревшее поле', 'устаревших поля', 'устаревших полей')} ещё в тестах`,
      hint: 'Поля помечены @deprecated, но тесты их выбирают. Когда поле удалят, тесты упадут: их стоит перевести заранее.',
      items: d.deprecatedInUse.map((x) => field(x.coordinate)),
    },
    {
      key: 'mutations',
      tone: 'danger',
      count: d.untestedMutations.length,
      title: `${plural(d.untestedMutations.length, 'мутация', 'мутации', 'мутаций')} без тестов`,
      hint: 'Операции записи, которые не вызывает ни один тест. Самый рискованный непроверенный код.',
      items: d.untestedMutations.map(field),
      action: { label: 'Заготовки в плане', to: `/plan?run=${id}&op=mutation` },
    },
    {
      key: 'subscriptions',
      tone: 'partial',
      count: d.untestedSubscriptions.length,
      title: `${plural(d.untestedSubscriptions.length, 'подписка', 'подписки', 'подписок')} без тестов`,
      hint: 'На эти события не подписывается ни один тест.',
      items: d.untestedSubscriptions.map(field),
      action: { label: 'Заготовки в плане', to: `/plan?run=${id}&op=subscription` },
    },
    {
      key: 'types',
      tone: 'partial',
      count: d.untouchedTypes.length,
      title: `${plural(d.untouchedTypes.length, 'тип', 'типа', 'типов')} не затронуто вовсе`,
      hint: 'Ни один запрос не дошёл до этих типов.',
      items: d.untouchedTypes.map((t) => ({ label: t, to: `/types/${t}?run=${id}` })),
      action: { label: 'Показать на карте', to: `/graph?run=${id}&uncovered=1` },
    },
    {
      key: 'conditional',
      tone: 'muted',
      count: d.conditionalOnly.length,
      title: `${plural(d.conditionalOnly.length, 'поле покрыто', 'поля покрыты', 'полей покрыто')} только условно`,
      hint: 'Выбирались только под @include/@skip с неизвестным условием: реально могли не запрашиваться.',
      items: d.conditionalOnly.map(field),
    },
    {
      key: 'args',
      tone: 'muted',
      count: d.unusedArguments.length,
      title: `${plural(d.unusedArguments.length, 'аргумент', 'аргумента', 'аргументов')} ни разу не передан`,
      hint: 'Поля вызываются, но без этих аргументов: пагинация, фильтры и сортировки не проверены.',
      items: d.unusedArguments.map((a) => ({
        label: a,
        to: `/fields/${a.slice(0, a.indexOf('('))}?run=${id}`,
      })),
    },
  ];
  const signals = candidates.filter((s) => s.count > 0);

  if (!signals.length) return null;
  return (
    <section className="mt-5" aria-label="Сигналы риска">
      <h2 className="text-base font-semibold">Сигналы риска</h2>
      <p className="mt-0.5 text-muted">То, что не видно по процентам покрытия.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {signals.map((s) => (
          <details key={s.key} className="group rounded-lg border border-line bg-surface p-4">
            <summary className="cursor-pointer list-none">
              <div className="flex items-baseline gap-2">
                <span className={`text-2xl font-semibold tabular-nums ${toneClass[s.tone]}`}>
                  {s.count}
                </span>
                <span className="font-medium">{s.title}</span>
                <svg
                  viewBox="0 0 12 12"
                  className="ml-auto size-3 shrink-0 self-center text-muted transition-transform group-open:rotate-180"
                  aria-hidden
                >
                  <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>
              <p className="mt-1 text-sm text-muted">{s.hint}</p>
            </summary>
            <ul className="mt-3 flex max-h-48 flex-wrap gap-x-3 gap-y-1 overflow-auto">
              {s.items.map((i) => (
                <li key={i.label}>
                  <Link to={i.to} className="hover:underline">
                    <Mono>{i.label}</Mono>
                  </Link>
                </li>
              ))}
            </ul>
            {s.action && (
              <Link to={s.action.to} className="mt-3 inline-block text-accent hover:underline">
                {s.action.label}
              </Link>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}
