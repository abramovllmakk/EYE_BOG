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
  shortId(r.id);

/** Automatic run ids are UUIDs: show their first 8 characters; explicit ids are shown in full. */
export const shortId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;

export type Status = 'covered' | 'partial' | 'uncovered' | 'via_interface';

export const statusText: Record<Status, string> = {
  covered: 'покрыто',
  partial: 'частично',
  uncovered: 'не покрыто',
  via_interface: 'через интерфейс',
};

/** Result of analysing a proxied request against the schema. */
export const ANALYSIS_LABEL: Record<string, string> = {
  valid: 'валиден',
  invalid: 'не прошёл валидацию',
  unresolved: 'APQ без текста',
  no_schema: 'нет схемы',
};

/** Russian plural: plural(5, 'поле', 'поля', 'полей') → 'полей'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
