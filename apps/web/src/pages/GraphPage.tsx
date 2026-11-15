import { useQuery } from '@tanstack/react-query';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { NeedRun } from '../components/Layout';
import { TypeCard, type TypeNode } from '../components/TypeCard';
import { Empty, ErrorBox, Legend, Loading, Select, Toggle, Bar, StatusDot } from '../components/ui';
import { api, type CoverageSummary, type SchemaModel, type TypeCoverage } from '../lib/api';
import { pct, statusText } from '../lib/format';
import { buildGraph, CARD_WIDTH, cardHeight, layout, type RootChoice } from '../lib/graph';
import { useBoolParam, useParam, useRunLink } from '../lib/url';

const nodeTypes = { type: TypeCard };
const edgeColor: Record<string, string> = {
  covered: 'var(--covered)',
  via_interface: 'var(--covered)',
  partial: 'var(--partial)',
  uncovered: 'var(--uncovered)',
};

function SidePanel({ type, onClose }: { type: TypeCoverage; onClose: () => void }) {
  const link = useRunLink();
  const items = type.fields.length ? type.fields : type.values;
  return (
    <aside
      className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col border-l border-line bg-surface"
      aria-label={`Тип ${type.name}`}
    >
      <div className="flex items-start gap-2 border-b border-line p-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{type.name}</div>
          <div className="text-muted">
            {statusText[type.status]}, {type.ratio.covered} из {type.ratio.total} (
            {pct(type.ratio.percent)})
          </div>
          <Bar value={type.ratio.percent} className="mt-2" />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 text-muted hover:bg-surface-2"
          aria-label="Закрыть панель"
        >
          ✕
        </button>
      </div>
      <ul className="flex-1 overflow-auto p-2">
        {items.map((f) => {
          const status = 'status' in f ? f.status : f.used ? 'covered' : 'uncovered';
          return (
            <li
              key={f.coordinate}
              className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2"
            >
              <StatusDot status={status} />
              {'status' in f ? (
                <Link to={link(`/fields/${f.coordinate}`)} className="truncate hover:underline">
                  {f.name}
                </Link>
              ) : (
                <span className="truncate">{f.name}</span>
              )}
              <span className="ml-auto tabular-nums text-muted">{f.requests || ''}</span>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line p-3">
        <Link
          to={link(`/types/${type.name}`)}
          className="block rounded-md bg-accent px-3 py-2 text-center text-white"
        >
          Открыть детализацию типа
        </Link>
      </div>
    </aside>
  );
}

function Canvas({
  model,
  types,
  summary,
}: {
  model: SchemaModel;
  types: TypeCoverage[];
  summary: CoverageSummary;
}) {
  const [root, setRoot] = useParam('root', 'query');
  const [focus, setFocus] = useParam('focus');
  const [depth, setDepth] = useParam('depth', '2');
  const [search, setSearch] = useParam('q');
  const [selected, setSelected] = useParam('sel');
  const [onlyUncovered, setOnlyUncovered] = useBoolParam('uncovered');
  const [showScalars, setShowScalars] = useBoolParam('scalars');
  const [showEnums, setShowEnums] = useBoolParam('enums');
  const [showInputs, setShowInputs] = useBoolParam('inputs');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const flow = useReactFlow();

  const graph = useMemo(
    () =>
      buildGraph(model, types, {
        root: root as RootChoice,
        focus: focus || null,
        depth: Number(depth) || 2,
        showScalars,
        showEnums,
        showInputs,
        onlyUncovered,
        expanded,
        maxNodes: 150,
      }),
    [model, types, root, focus, depth, showScalars, showEnums, showInputs, onlyUncovered, expanded],
  );

  useEffect(() => {
    let cancelled = false;
    setLayoutError(null);
    layout(graph)
      .then((p) => {
        if (cancelled) return;
        setPositions(p);
        requestAnimationFrame(() => void flow.fitView({ padding: 0.1, maxZoom: 1 }));
      })
      .catch((e: Error) => !cancelled && setLayoutError(e.message));
    return () => {
      cancelled = true;
    };
  }, [graph, flow]);

  const q = search.trim().toLowerCase();
  const nodes: TypeNode[] = useMemo(
    () =>
      positions
        ? [...graph.cards.entries()].map(([id, data]) => ({
            id,
            type: 'type' as const,
            position: positions.get(id) ?? { x: 0, y: 0 },
            width: CARD_WIDTH,
            height: cardHeight(data),
            data: {
              ...data,
              selected: id === selected,
              matched:
                !!q &&
                (id.toLowerCase().includes(q) ||
                  data.rows.some((r) => r.name.toLowerCase().includes(q))),
              onExpand: (n: string) => setExpanded((s) => new Set(s).add(n)),
            },
          }))
        : [],
    [graph, positions, selected, q],
  );
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: 'in',
        type: 'default',
        style: {
          stroke: edgeColor[e.status],
          strokeWidth: e.status === 'covered' ? 1.6 : 1,
          strokeDasharray: e.kind === 'implements' ? '4 4' : undefined,
          opacity: e.status === 'uncovered' ? 0.6 : 1,
        },
      })),
    [graph],
  );

  const onNodeClick: NodeMouseHandler = (_, node) =>
    setSelected(node.id === selected ? null : node.id);
  const selectedType = types.find((t) => t.name === selected);
  const matches = q ? model.types.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 8) : [];

  return (
    <div className="relative h-full">
      <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-end gap-3 rounded-lg border border-line bg-surface/95 p-3 shadow-sm">
        <Select
          label="Корень"
          value={root}
          onChange={setRoot}
          placeholder={null}
          options={[
            { value: 'query', label: model.roots.query ?? 'Query' },
            ...(model.roots.mutation ? [{ value: 'mutation', label: model.roots.mutation }] : []),
            ...(model.roots.subscription
              ? [{ value: 'subscription', label: model.roots.subscription }]
              : []),
            { value: 'all', label: 'вся схема' },
          ]}
        />
        <div className="relative">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Поиск типа или поля
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches[0]) setFocus(matches[0].name);
              }}
              placeholder="User, posts…"
              className="h-8 w-48 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            />
          </label>
          {matches.length > 0 && (
            <ul className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-line bg-surface p-1 shadow">
              {matches.map((m) => (
                <li key={m.name}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1 text-left hover:bg-surface-2"
                    onClick={() => (setFocus(m.name), setSearch(null))}
                  >
                    {m.name} <span className="text-xs text-muted">{m.kind.toLowerCase()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {focus && (
          <div className="flex items-end gap-2">
            <Select
              label={`Соседи ${focus}`}
              value={depth}
              onChange={setDepth}
              placeholder={null}
              options={['1', '2', '3', '4', '5'].map((d) => ({ value: d, label: `${d} ур.` }))}
            />
            <button
              type="button"
              className="h-8 rounded-md border border-line px-2"
              onClick={() => setFocus(null)}
            >
              Сбросить фокус
            </button>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Toggle label="Только непокрытое" checked={onlyUncovered} onChange={setOnlyUncovered} />
          <div className="flex gap-3">
            <Toggle label="enum" checked={showEnums} onChange={setShowEnums} />
            <Toggle label="input" checked={showInputs} onChange={setShowInputs} />
            <Toggle label="scalar" checked={showScalars} onChange={setShowScalars} />
          </div>
        </div>
      </div>

      <div className="absolute bottom-3 left-14 z-10 flex flex-col gap-1 rounded-lg border border-line bg-surface/95 px-3 py-2">
        <Legend />
        <div className="text-xs text-muted tabular-nums">
          Поля {pct(summary.fields.percent)}, типы {pct(summary.types.percent)}, операции{' '}
          {pct(summary.operations.percent)}. На графе {graph.cards.size} типов.
        </div>
        {graph.limited && (
          <div className="text-xs text-partial">
            Схема большая ({graph.totalCandidates} типов): показана окрестность корня. Найдите тип
            через поиск, чтобы увидеть его соседей.
          </div>
        )}
      </div>

      {layoutError && <ErrorBox error={new Error(`Раскладка графа не удалась: ${layoutError}`)} />}
      {!positions && !layoutError && <Loading what="раскладку графа" />}
      {graph.cards.size === 0 && positions && (
        <div className="absolute inset-x-0 top-40 z-10">
          <Empty title="По фильтрам ничего не осталось">
            {onlyUncovered
              ? 'Все типы, достижимые от этого корня, полностью покрыты.'
              : 'Измените корень или включите enum и input.'}
          </Empty>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onlyRenderVisibleElements
        nodesConnectable={false}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="var(--line)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeClassName={(n) =>
            `mm-${(n.data as TypeNode['data']).coverage?.status ?? 'uncovered'}`
          }
          style={{ marginRight: selectedType ? 336 : 12 }}
        />
      </ReactFlow>
      {selectedType && <SidePanel type={selectedType} onClose={() => setSelected(null)} />}
    </div>
  );
}

export function GraphPage() {
  const [run] = useParam('run');
  const schema = useQuery({
    queryKey: ['schema', run],
    queryFn: () => api<SchemaModel>(`/api/runs/${run}/schema`),
    enabled: !!run,
  });
  const cov = useQuery({
    queryKey: ['coverage', run],
    queryFn: () =>
      api<{ summary: CoverageSummary; types: TypeCoverage[] }>(`/api/runs/${run}/coverage`),
    enabled: !!run,
  });
  if (!run) return <NeedRun />;
  if (schema.error || cov.error) return <ErrorBox error={schema.error ?? cov.error} />;
  if (!schema.data || !cov.data) return <Loading what="схему и покрытие" />;
  return (
    <ReactFlowProvider>
      <Canvas model={schema.data} types={cov.data.types} summary={cov.data.summary} />
    </ReactFlowProvider>
  );
}
