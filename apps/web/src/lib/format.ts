export const pct = (n: number | null | undefined) =>
  n == null ? '—' : `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;

export const dateTime = (ms: number | null | undefined) =>
  ms == null
    ? '—'
    : new Date(ms).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

export const runLabel = (r: {
  id: string;
  branch: string | null;
  environment: string | null;
  buildId: string | null;
  startedAt: number;
}) =>
  [r.branch, r.environment, r.buildId && `#${r.buildId}`].filter(Boolean).join(' / ') ||
  r.id.slice(0, 8);

export type Status = 'covered' | 'partial' | 'uncovered' | 'via_interface';

export const statusText: Record<Status, string> = {
  covered: 'покрыто',
  partial: 'частично',
  uncovered: 'не покрыто',
  via_interface: 'через интерфейс',
};
