import { useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { NeedRun } from '../components/Layout';
import {
  ErrorBox,
  Loading,
  Metric,
  Select,
  StatusDot,
  TextInput,
  Empty,
  Mono,
} from '../components/ui';
import { api, type CoverageSummary, type TypeCoverage } from '../lib/api';
import { statusText, type Status } from '../lib/format';
import { useParam, useRunLink } from '../lib/url';

interface FieldRow {
  coordinate: string;
  typeName: string;
  kind: string;
  name: string;
  type: string;
  status: Status;
  requests: number;
  occurrences: number;
  tests: number;
  maxDepth: number | null;
  args: string;
  services: string;
}

const col = createColumnHelper<FieldRow>();

export function Summary({ s }: { s: CoverageSummary }) {
  return (
    <div className="flex flex-wrap gap-3">
      <Metric
        label="Поля"
        value={s.fields.percent}
        detail={`${s.fields.covered} из ${s.fields.total}`}
      />
      <Metric
        label="Типы (затронуты)"
        value={s.types.percent}
        detail={`${s.types.covered} из ${s.types.total}, полностью ${s.types.fullyCovered}`}
      />
      <Metric
        label="Операции"
        value={s.operations.percent}
        detail={`query ${s.operations.query.covered}/${s.operations.query.total}, mutation ${s.operations.mutation.covered}/${s.operations.mutation.total}, subscription ${s.operations.subscription.covered}/${s.operations.subscription.total}`}
      />
      <Metric
        label="Аргументы"
        value={s.arguments.percent}
        detail={`${s.arguments.covered} из ${s.arguments.total}`}
      />
      <Metric
        label="Значения enum"
        value={s.enumValues.percent}
        detail={`${s.enumValues.covered} из ${s.enumValues.total}`}
      />
      <Metric
        label="Поля input"
        value={s.inputFields.percent}
        detail={`${s.inputFields.covered} из ${s.inputFields.total}`}
      />
      <Metric
        label="Связи"
        value={s.edges.percent}
        detail={`глубина до ${s.maxDepth}, тестов ${s.tests}`}
      />
    </div>
  );
}

export function TablePage() {
  const [run] = useParam('run');
  const [view, setView] = useParam('view', 'all');
  const [status, setStatus] = useParam('status');
  const [kind, setKind] = useParam('kind');
  const [search, setSearch] = useParam('q');
  const [suite, setSuite] = useParam('suite');
  const [service, setService] = useParam('service');
  const link = useRunLink();
  const groups = useQuery({
    queryKey: ['groups', run],
    queryFn: () => api<{ suite: string }[]>(`/api/runs/${run}/groups`),
    enabled: !!run,
  });
  const cov = useQuery({
    queryKey: ['coverage', run, suite],
    queryFn: () =>
      api<{ summary: CoverageSummary; types: TypeCoverage[] }>(
        `/api/runs/${run}/coverage${suite ? `?testSuite=${encodeURIComponent(suite)}` : ''}`,
      ),
    enabled: !!run,
  });
  const [sorting, setSorting] = useState<SortingState>([]);

  const rows = useMemo<FieldRow[]>(() => {
    const out: FieldRow[] = [];
    for (const t of cov.data?.types ?? []) {
      for (const f of t.fields) {
        out.push({
          coordinate: f.coordinate,
          typeName: t.name,
          kind: t.kind,
          name: f.name,
          type: f.type,
          status: f.status,
          requests: f.requests,
          occurrences: f.occurrences,
          tests: f.tests,
          maxDepth: f.maxDepth,
          args: f.args.map((a) => `${a.used ? '●' : '○'} ${a.name}`).join('  '),
          services: f.services.join(', '),
        });
      }
    }
    return out;
  }, [cov.data]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    let r = rows.filter(
      (x) =>
        (!status || x.status === status) &&
        (!kind || x.kind === kind) &&
        (!q || x.coordinate.toLowerCase().includes(q)),
    );
    if (view === 'top')
      r = [...r]
        .filter((x) => x.requests > 0)
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 25);
    if (view === 'never') r = r.filter((x) => x.status !== 'covered');
    return r;
  }, [rows, search, status, kind, view, service]);

  const columns = useMemo(
    () => [
      col.accessor('status', {
        header: 'Статус',
        cell: (c) => (
          <span className="flex items-center gap-2">
            <StatusDot status={c.getValue()} /> {statusText[c.getValue()]}
          </span>
        ),
      }),
      col.accessor('coordinate', {
        header: 'Поле',
        cell: (c) => (
          <Link to={link(`/fields/${c.getValue()}`)} className="hover:underline">
            <Mono>{c.getValue()}</Mono>
          </Link>
        ),
      }),
      col.accessor('type', {
        header: 'Тип',
        cell: (c) => <Mono className="text-muted">{c.getValue()}</Mono>,
      }),
      col.accessor('requests', {
        header: 'Запросов',
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      col.accessor('occurrences', {
        header: 'Вхождений',
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      col.accessor('tests', {
        header: 'Тестов',
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      col.accessor('maxDepth', {
        header: 'Глубина',
        cell: (c) => <span className="tabular-nums">{c.getValue() ?? ''}</span>,
      }),
      col.accessor('args', {
        header: 'Аргументы',
        enableSorting: false,
        cell: (c) => <span className="text-xs text-muted">{c.getValue()}</span>,
      }),
    ],
    [link],
  );
  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (!run) return <NeedRun />;
  if (cov.error) return <ErrorBox error={cov.error} />;
  if (!cov.data) return <Loading what="покрытие" />;
  const tabs = [
    { v: 'all', l: 'Все поля' },
    { v: 'top', l: 'Самые используемые' },
    { v: 'never', l: 'Ни разу не затронуты' },
  ];
  return (
    <div className="mx-auto max-w-7xl p-6">
      <Summary s={cov.data.summary} />
      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="mr-auto flex gap-1" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.v}
              role="tab"
              aria-selected={view === t.v}
              type="button"
              onClick={() => setView(t.v)}
              className={`rounded-md px-3 py-1.5 ${view === t.v ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-surface'}`}
            >
              {t.l}
            </button>
          ))}
        </div>
        <TextInput label="Поиск" value={search} onChange={setSearch} placeholder="User.name" />
        <Select
          label="Статус"
          value={status}
          onChange={setStatus}
          options={(['covered', 'via_interface', 'uncovered'] as Status[]).map((s) => ({
            value: s,
            label: statusText[s],
          }))}
        />
        <Select
          label="Вид типа"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'OBJECT', label: 'type' },
            { value: 'INTERFACE', label: 'interface' },
          ]}
        />
        <Select
          label="Набор тестов"
          value={suite}
          onChange={setSuite}
          options={(groups.data ?? []).map((g) => g.suite)}
        />
        {cov.data.summary.services.length > 0 && (
          <Select
            label="Сервис"
            value={service}
            onChange={setService}
            options={cov.data.summary.services.map((x) => x.service)}
          />
        )}
      </div>
      {filtered.length === 0 ? (
        <Empty title={view === 'never' ? 'Непокрытых полей нет' : 'Ничего не найдено'}>
          {view === 'never'
            ? 'Каждое поле схемы затронуто хотя бы одним запросом.'
            : 'Измените поиск или фильтры.'}
        </Empty>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left">
            <thead className="border-b border-line text-xs text-muted">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th key={h.id} className="px-3 py-2 font-medium">
                      {h.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="flex items-center gap-1 hover:text-ink"
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {{ asc: '▲', desc: '▼' }[h.column.getIsSorted() as string] ?? ''}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-line last:border-0 hover:bg-surface-2 ${r.original.status === 'via_interface' ? 'via-interface' : ''}`}
                >
                  {r.getVisibleCells().map((c) => (
                    <td key={c.id} className="px-3 py-1.5">
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">{filtered.length} строк</p>
    </div>
  );
}
