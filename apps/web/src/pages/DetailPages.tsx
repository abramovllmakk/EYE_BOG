import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { NeedRun } from '../components/Layout';
import { QueryView } from '../components/QueryView';
import { Bar, Empty, ErrorBox, Loading, Mono, StatusDot } from '../components/ui';
import { api, type FieldDetail, type Operation, type TypeDetail } from '../lib/api';
import { dateTime, pct, statusText } from '../lib/format';
import { useParam, useRunLink } from '../lib/url';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-6">
    <h2 className="mb-2 text-sm font-semibold">{title}</h2>
    {children}
  </section>
);

export function TypePage() {
  const { name } = useParams();
  const [run] = useParam('run');
  const link = useRunLink();
  const q = useQuery({
    queryKey: ['type', run, name],
    queryFn: () => api<TypeDetail>(`/api/runs/${run}/types/${name}`),
    enabled: !!run,
  });
  if (!run) return <NeedRun />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading what="тип" />;
  const { type, model, fieldTests, referencedBy } = q.data;
  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">{model.name}</h1>
        <span className="text-muted">{model.kind.toLowerCase()}</span>
        <Link
          to={link('/graph', { focus: model.name })}
          className="ml-auto text-accent hover:underline"
        >
          Показать на графе
        </Link>
      </div>
      {model.description && <p className="mt-1 max-w-prose text-muted">{model.description}</p>}
      {type && (
        <div className="mt-4 max-w-md">
          <div className="flex justify-between text-muted">
            <span>{statusText[type.status]}</span>
            <span className="tabular-nums">
              {type.ratio.covered} из {type.ratio.total}, {pct(type.ratio.percent)}
            </span>
          </div>
          <Bar value={type.ratio.percent} className="mt-1" />
          <p className="mt-2 text-muted">
            Использовался в <span className="tabular-nums text-ink">{type.requests}</span> запросах
            {type.occurrences > 0 && <> ({type.occurrences} обращений к полям)</>}.
          </p>
        </div>
      )}
      {model.interfaces.length > 0 && (
        <p className="mt-3 text-muted">
          Реализует:{' '}
          {model.interfaces.map((i) => (
            <Link key={i} to={link(`/types/${i}`)} className="mr-2 text-accent hover:underline">
              {i}
            </Link>
          ))}
        </p>
      )}
      {model.possibleTypes.length > 0 && (
        <p className="mt-1 text-muted">
          {model.kind === 'UNION' ? 'Члены' : 'Реализации'}:{' '}
          {model.possibleTypes.map((i) => (
            <Link key={i} to={link(`/types/${i}`)} className="mr-2 text-accent hover:underline">
              {i}
            </Link>
          ))}
        </p>
      )}
      {type && type.fields.length > 0 && (
        <Section title="Поля">
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-left">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Поле</th>
                  <th className="px-3 py-2 font-medium">Запросов</th>
                  <th className="px-3 py-2 font-medium">Аргументы</th>
                  <th className="px-3 py-2 font-medium">Тесты</th>
                </tr>
              </thead>
              <tbody>
                {type.fields.map((f) => (
                  <tr
                    key={f.name}
                    className={`border-b border-line align-top last:border-0 ${f.status === 'via_interface' ? 'via-interface' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <StatusDot status={f.status} />
                        <Link to={link(`/fields/${f.coordinate}`)} className="hover:underline">
                          <Mono>{f.name}</Mono>
                        </Link>
                        <Mono className="text-muted">{f.type}</Mono>
                      </span>
                      {f.viaInterfaces.length > 0 && (
                        <div className="ml-4 text-xs text-muted">
                          покрыто через {f.viaInterfaces.join(', ')}
                        </div>
                      )}
                      {f.conditionalOnly && (
                        <div className="ml-4 text-xs text-partial">
                          только под @include/@skip с неизвестным условием
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{f.requests || ''}</td>
                    <td className="px-3 py-2 text-xs">
                      {f.args.map((a) => (
                        <div key={a.name} className={a.used ? '' : 'text-muted'}>
                          <StatusDot status={a.used ? 'covered' : 'uncovered'} className="mr-1.5" />
                          {a.name}
                          {a.used ? ` (${a.requests})` : ''}
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {(fieldTests[f.name] ?? []).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {type && type.values.length > 0 && (
        <Section
          title={
            model.kind === 'ENUM'
              ? 'Значения'
              : model.kind === 'UNION'
                ? 'Члены, выбранные через фрагменты'
                : 'Поля input'
          }
        >
          <ul className="flex flex-wrap gap-2">
            {type.values.map((v) => (
              <li
                key={v.name}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${v.used ? 'border-covered bg-covered-soft' : 'border-line bg-surface'}`}
              >
                <StatusDot status={v.used ? 'covered' : 'uncovered'} />
                <Mono>{v.name}</Mono>
                {v.used && <span className="text-xs text-muted tabular-nums">{v.requests}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {referencedBy.length > 0 && (
        <Section title="Ссылаются на тип">
          <p className="text-muted">
            {referencedBy.map((r) => (
              <Link key={r} to={link(`/fields/${r}`)} className="mr-3 hover:underline">
                <Mono>{r}</Mono>
              </Link>
            ))}
          </p>
        </Section>
      )}
    </div>
  );
}

export function FieldPage() {
  const { coordinate } = useParams();
  const [run] = useParam('run');
  const link = useRunLink();
  const q = useQuery({
    queryKey: ['field', run, coordinate],
    queryFn: () => api<FieldDetail>(`/api/runs/${run}/fields/${coordinate}`),
    enabled: !!run,
  });
  if (!run) return <NeedRun />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading what="поле" />;
  const d = q.data;
  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="text-muted">
        <Link to={link(`/types/${d.typeName}`)} className="hover:underline">
          {d.typeName}
        </Link>
      </div>
      <h1 className="flex items-center gap-3 text-xl font-semibold">
        <StatusDot status={d.coverage.status} className="size-3" />
        <Mono className="text-xl">{d.coordinate}</Mono>
        <Mono className="text-muted">{d.model.type}</Mono>
      </h1>
      <p className="mt-1 text-muted">
        {statusText[d.coverage.status]}
        {d.coverage.viaInterfaces.length > 0 && ` (через ${d.coverage.viaInterfaces.join(', ')})`}
      </p>
      {d.hit ? (
        <>
          <dl className="mt-4 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Запросов', d.hit.requests],
              ['Вхождений', d.hit.occurrences],
              ['Тестов', d.tests.length],
              [
                'Глубина',
                d.hit.minDepth === d.hit.maxDepth
                  ? d.hit.minDepth
                  : `${d.hit.minDepth}–${d.hit.maxDepth}`,
              ],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded-md border border-line bg-surface px-3 py-2">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="text-lg font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {(d.hit.aliases.length > 0 || d.hit.fragments.length > 0) && (
            <p className="mt-3 text-muted">
              {d.hit.aliases.length > 0 && (
                <>
                  Алиасы: <Mono className="text-ink">{d.hit.aliases.join(', ')}</Mono>.{' '}
                </>
              )}
              {d.hit.fragments.length > 0 && (
                <>
                  Через фрагменты: <Mono className="text-ink">{d.hit.fragments.join(', ')}</Mono>.
                </>
              )}
            </p>
          )}
          <Section title="Аргументы">
            {d.coverage.args.length === 0 ? (
              <p className="text-muted">Без аргументов.</p>
            ) : (
              <ul>
                {d.coverage.args.map((a) => (
                  <li key={a.name} className="flex items-center gap-2">
                    <StatusDot status={a.used ? 'covered' : 'uncovered'} />
                    <Mono>{a.name}</Mono>{' '}
                    <span className="text-muted">
                      {a.used ? `передан в ${a.requests} запросах` : 'ни разу не передан'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Пути от корня">
            <ul className="font-mono text-[13px]">
              {d.hit.paths.map((p) => (
                <li key={p.path}>
                  {p.path} <span className="text-muted">({p.requests})</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Тесты, которые затрагивают поле">
            <ul>
              {d.tests.map((t) => (
                <li key={t.testKey}>
                  {t.suite && <span className="text-muted">{t.suite} / </span>}
                  {t.name} <span className="text-muted tabular-nums">({t.requests})</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section
            title={`Запросы (последние ${d.operations.items.length} из ${d.operations.total})`}
          >
            <OperationList items={d.operations.items} />
          </Section>
        </>
      ) : (
        <Empty title="Поле ни разу не запрашивалось в этом прогоне">
          Добавьте тест, который выбирает {d.coordinate}, и прогоните его через прокси.
        </Empty>
      )}
    </div>
  );
}

export function OperationList({ items }: { items: Operation[] }) {
  const link = useRunLink();
  if (items.length === 0) return <p className="text-muted">Запросов нет.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-left">
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Операция</th>
            <th className="px-3 py-2 font-medium">Тест</th>
            <th className="px-3 py-2 font-medium">Анализ</th>
            <th className="px-3 py-2 font-medium">HTTP</th>
            <th className="px-3 py-2 font-medium">Время</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface-2">
              <td className="px-3 py-1.5">
                <Link to={link(`/operations/${o.id}`)} className="hover:underline">
                  {o.operationType ?? '?'}{' '}
                  {o.operationName ?? <span className="text-muted">анонимная</span>}
                </Link>
                {o.batchIndex != null && (
                  <span className="ml-1 text-xs text-muted">batch #{o.batchIndex}</span>
                )}
              </td>
              <td className="px-3 py-1.5">
                {o.testName ?? <span className="text-muted">unknown</span>}
              </td>
              <td className={`px-3 py-1.5 ${o.status === 'valid' ? '' : 'text-danger'}`}>
                {o.status}
              </td>
              <td className="px-3 py-1.5 tabular-nums">
                {o.httpStatus}
                {o.hasErrors ? <span className="text-danger"> errors</span> : ''}
              </td>
              <td className="px-3 py-1.5 tabular-nums text-muted">{dateTime(o.ts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OperationPage() {
  const { id } = useParams();
  const link = useRunLink();
  const q = useQuery({
    queryKey: ['op', id],
    queryFn: () => api<Operation>(`/api/operations/${id}`),
  });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading what="запрос" />;
  const o = q.data;
  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-xl font-semibold">
        {o.operationType ?? 'запрос'} {o.operationName ?? 'без имени'}
      </h1>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        {[
          ['Тест', [o.testSuite, o.testName].filter(Boolean).join(' / ') || 'unknown'],
          ['Анализ', o.status],
          ['HTTP-статус', `${o.httpStatus ?? '—'}${o.hasErrors ? ', в ответе есть errors' : ''}`],
          ['Задержка', o.latencyMs != null ? `${o.latencyMs} мс` : '—'],
          ['Транспорт', o.transport ?? '—'],
          ['Время', dateTime(o.ts)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {o.errors.length > 0 && (
        <div className="mt-4 rounded-md border border-danger/40 bg-surface p-3 text-danger">
          {o.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
      <Section title="Текст запроса">
        {o.query ? (
          <QueryView text={o.query} />
        ) : (
          <p className="text-muted">Текст неизвестен (APQ без связки hash → query).</p>
        )}
      </Section>
      <Section title="Переменные (после редакции)">
        <pre className="overflow-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-[13px]">
          {JSON.stringify(o.variables, null, 2) ?? 'нет'}
        </pre>
      </Section>
      <Section title={`Покрытые поля (${o.fields.length})`}>
        <ul className="flex flex-wrap gap-2">
          {o.fields.map((f) => (
            <li key={f}>
              <Link
                to={link(`/fields/${f}`, { run: o.runId })}
                className="rounded-md border border-covered bg-covered-soft px-2 py-0.5 font-mono text-[13px] hover:underline"
              >
                {f}
              </Link>
            </li>
          ))}
        </ul>
      </Section>
      {o.headers && (
        <Section title="Заголовки запроса (секреты замаскированы)">
          <pre className="overflow-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-xs">
            {Object.entries(o.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}
          </pre>
        </Section>
      )}
    </div>
  );
}
