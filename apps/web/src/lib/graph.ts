import ELK, { type ElkNode } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { cardHeight, CARD_WIDTH, type BuiltGraph } from './graph-model';

export * from './graph-model';

/** Layout runs in a Web Worker so large schemas never block the UI thread. */
const elk = new ELK({ workerUrl });

export async function layout(g: BuiltGraph): Promise<Map<string, { x: number; y: number }>> {
  const children: ElkNode[] = [...g.cards.entries()].map(([id, c]) => ({
    id,
    width: CARD_WIDTH,
    height: cardHeight(c),
    layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' },
    ports: [
      { id: `${id}::in`, layoutOptions: { 'elk.port.side': 'WEST' } },
      ...c.rows.map((r) => ({ id: `${id}::${r.key}`, layoutOptions: { 'elk.port.side': 'EAST' } })),
      { id: `${id}::impl`, layoutOptions: { 'elk.port.side': 'NORTH' } },
    ],
  }));
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '28',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children,
    edges: g.edges
      .filter((e) => e.source !== e.target)
      .map((e) => ({
        id: e.id,
        sources: [`${e.source}::${e.sourceHandle}`],
        targets: [`${e.target}::in`],
      })),
  });
  return new Map((res.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}
