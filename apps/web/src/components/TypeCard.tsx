import { Handle, Position, useStore, type NodeProps, type Node } from '@xyflow/react';
import { memo } from 'react';
import { Link } from 'react-router';
import type { CardData } from '../lib/graph';
import { HEADER_H, ROW_H } from '../lib/graph';
import { pct } from '../lib/format';
import { useRunLink } from '../lib/url';
import { StatusDot } from './ui';

/** Below this zoom level cards switch to the compact, large-type view. */
const COMPACT_ZOOM = 0.6;

const kindLabel: Record<string, string> = {
  OBJECT: 'type',
  INTERFACE: 'interface',
  UNION: 'union',
  ENUM: 'enum',
  INPUT_OBJECT: 'input',
  SCALAR: 'scalar',
};

const border: Record<string, string> = {
  covered: 'border-covered',
  partial: 'border-partial',
  uncovered: 'border-line',
};

export type TypeNode = Node<
  CardData & {
    selected?: boolean;
    matched?: boolean;
    onExpand?: (n: string) => void;
    /** Fields touched by the selected test; everything else is dimmed. */
    trace?: Set<string> | null;
    /** Fields that just became covered in a live run. */
    fresh?: Set<string>;
  },
  'type'
>;

/** Voyager-like type card: header with coverage, one row per field with an outgoing handle. */
export const TypeCard = memo(function TypeCard({ data }: NodeProps<TypeNode>) {
  const link = useRunLink();
  const c = data.coverage;
  const status = c?.status ?? 'uncovered';
  const percent = c?.ratio.percent ?? null;
  const coord = (r: { name: string }) => `${data.type.name}.${r.name}`;
  const touched = !data.trace || data.rows.some((r) => data.trace!.has(coord(r)));
  // Semantic zoom: zoomed out, a card shows its name and coverage in large type instead of
  // unreadable rows (rows and their handles stay underneath, so edges keep their anchors).
  const compact = useStore((st) => st.transform[2] < COMPACT_ZOOM);
  const short = data.rows.length + (data.hidden > 0 ? 1 : 0) <= 4;
  const traced = data.trace ? data.rows.filter((r) => data.trace!.has(coord(r))).length : 0;
  return (
    <div
      className={`relative w-[280px] overflow-hidden rounded-lg border-2 bg-surface text-[13px] shadow-sm transition-opacity ${border[status]} ${data.selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''} ${data.matched ? 'outline outline-2 outline-partial' : ''} ${touched ? '' : 'opacity-20'}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        style={{ top: HEADER_H / 2 }}
        className="!size-2 !border-0 !bg-muted"
      />
      <Handle
        type="source"
        position={Position.Top}
        id="impl"
        className="!size-1.5 !border-0 !bg-transparent"
      />
      <div
        className="flex flex-col justify-center gap-1 border-b border-line bg-surface-2 px-3"
        style={{ height: HEADER_H }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-muted">{kindLabel[data.type.kind]}</span>
          <span className="truncate font-semibold">{data.type.name}</span>
          {c && <span className="ml-auto tabular-nums text-muted">{pct(percent)}</span>}
        </div>
        {c && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-uncovered-soft">
            <div
              className={`h-full ${status === 'covered' ? 'bg-covered' : status === 'partial' ? 'bg-partial' : ''}`}
              style={{ width: `${percent ?? 0}%` }}
            />
          </div>
        )}
      </div>
      <ul>
        {data.rows.map((r) => (
          <li
            key={r.key}
            className={`relative flex items-center gap-2 px-3 ${r.status === 'via_interface' ? 'via-interface' : ''} ${data.trace ? (data.trace.has(coord(r)) ? 'bg-accent-soft' : 'opacity-35') : ''} ${data.fresh?.has(coord(r)) ? 'fresh-row' : ''}`}
            style={{ height: ROW_H }}
          >
            <StatusDot status={r.status} />
            {r.link ? (
              <Link
                to={link(`/fields/${data.type.name}.${r.name}`)}
                className="nodrag truncate hover:underline"
              >
                {r.name}
              </Link>
            ) : (
              <span className="truncate">{r.name}</span>
            )}
            {r.detail && <span className="truncate font-mono text-xs text-muted">{r.detail}</span>}
            {r.requests > 0 && (
              <span className="ml-auto pl-1 text-xs tabular-nums text-muted" title="запросов">
                {r.requests}
              </span>
            )}
            <Handle
              type="source"
              position={Position.Right}
              id={r.key}
              className="!size-1.5 !border-0 !bg-muted"
              style={{ top: ROW_H / 2 }}
            />
          </li>
        ))}
        {data.rows.length === 0 && (
          <li className="px-3 text-muted" style={{ height: ROW_H }}>
            нет элементов по фильтру
          </li>
        )}
        {data.hidden > 0 && (
          <li style={{ height: ROW_H }} className="px-3">
            <button
              type="button"
              className="nodrag text-accent hover:underline"
              onClick={() => data.onExpand?.(data.type.name)}
            >
              показать ещё {data.hidden}
            </button>
          </li>
        )}
      </ul>
      {compact && (
        <div
          className={`pointer-events-none absolute inset-0 z-10 flex flex-col justify-center bg-surface px-5 ${short ? 'gap-2' : 'gap-3'}`}
          aria-hidden
        >
          {!short && <div className="text-xl text-muted">{kindLabel[data.type.kind]}</div>}
          <div className="flex items-baseline gap-3">
            <span
              className={`min-w-0 flex-1 truncate leading-tight font-semibold ${short ? 'text-[26px]' : 'text-[40px]'}`}
            >
              {data.type.name}
            </span>
          </div>
          {c && (
            <div className="flex items-center gap-3">
              <div
                className={`flex-1 overflow-hidden rounded-full bg-uncovered-soft ${short ? 'h-2.5' : 'h-4'}`}
              >
                <div
                  className={`h-full rounded-full ${status === 'covered' ? 'bg-covered' : status === 'partial' ? 'bg-partial' : ''}`}
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
              <span
                className={`font-semibold tabular-nums ${short ? 'text-[22px]' : 'text-[32px]'}`}
              >
                {pct(percent)}
              </span>
            </div>
          )}
          {c && !short && (
            <div className="text-xl text-muted tabular-nums">
              {data.trace ? (
                <span className="text-accent">тест затрагивает {traced}</span>
              ) : (
                <>
                  {c.ratio.covered} из {c.ratio.total}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
