import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { pct, statusText, type Status } from '../lib/format';

const statusColor: Record<Status, string> = {
  covered: 'bg-covered',
  partial: 'bg-partial',
  uncovered: 'bg-uncovered',
  via_interface: 'bg-covered/50',
};

export function StatusDot({ status, className = '' }: { status: Status; className?: string }) {
  return (
    <span
      title={statusText[status]}
      aria-label={statusText[status]}
      className={`inline-block size-2.5 shrink-0 rounded-full ${statusColor[status]} ${status === 'via_interface' ? 'ring-1 ring-covered' : ''} ${className}`}
    />
  );
}

/** Colour of an aggregate coverage level: green from 80%, amber from 50%, red below. */
export function levelTone(value: number): 'covered' | 'partial' | 'danger' | 'uncovered' {
  if (value >= 80) return 'covered';
  if (value >= 50) return 'partial';
  return value > 0 ? 'danger' : 'uncovered';
}
const levelBg = {
  covered: 'bg-covered',
  partial: 'bg-partial',
  danger: 'bg-danger',
  uncovered: 'bg-uncovered',
};

/**
 * Horizontal coverage bar. `level` (default) colours aggregate percentages by threshold;
 * `status` follows the type status (100% covered, otherwise partial) where that is what it shows.
 */
export function Bar({
  value,
  className = '',
  mode = 'level',
}: {
  value: number;
  className?: string;
  mode?: 'level' | 'status';
}) {
  const color =
    mode === 'status'
      ? value >= 100
        ? 'bg-covered'
        : value > 0
          ? 'bg-partial'
          : 'bg-uncovered'
      : levelBg[levelTone(value)];
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-uncovered-soft ${className}`}
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${Math.max(value, value > 0 ? 2 : 0)}%` }}
      />
    </div>
  );
}

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null | undefined;
  detail?: string;
}) {
  return (
    <div className="min-w-32 flex-1 rounded-md border border-line bg-surface px-4 py-3">
      <div className="text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{pct(value)}</div>
      {value != null && <Bar value={value} className="mt-2" />}
      {detail && <div className="mt-1.5 text-xs text-muted tabular-nums">{detail}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="relative z-0 mx-auto my-16 max-w-xl rounded-lg border border-dashed border-line bg-surface px-6 py-8 text-center">
      <h2 className="text-base font-semibold">{title}</h2>
      {children && <div className="mt-2 text-muted">{children}</div>}
    </div>
  );
}

export function Loading({ what = 'данные' }: { what?: string }) {
  return (
    <div className="p-8 text-muted" role="status">
      Загружаю {what}…
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const e = error as Error;
  const hint = e instanceof ApiError ? e.hint : null;
  return (
    <div className="m-6 rounded-md border border-danger/40 bg-surface p-4" role="alert">
      <div className="font-medium text-danger">
        {e instanceof ApiError && e.status === 404 ? 'Не найдено' : 'Ошибка запроса к API'}
      </div>
      <div className="mt-1">{e.message}</div>
      {hint && <div className="mt-2 text-muted">{hint}</div>}
    </div>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
  placeholder = 'все',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: (string | { value: string; label: string })[];
  placeholder?: string | null;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-32 rounded-md border border-line bg-surface px-2 text-sm text-ink"
      >
        {placeholder !== null && <option value="">{placeholder}</option>}
        {options.map((o) => {
          const v = typeof o === 'string' ? o : o.value;
          return (
            <option key={v} value={v}>
              {typeof o === 'string' ? o : o.label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-40 rounded-md border border-line bg-surface px-2 text-sm text-ink placeholder:text-muted/70"
      />
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}

export function Legend() {
  const items: Status[] = ['covered', 'partial', 'uncovered', 'via_interface'];
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted"
      aria-label="Легенда цветов"
    >
      {items.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <StatusDot status={s} />
          {statusText[s]}
        </span>
      ))}
    </div>
  );
}

export const Mono = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <span
    className={`font-mono ${/\btext-(xs|sm|base|lg|xl|2xl|\[)/.test(className) ? '' : 'text-[13px]'} ${className}`}
  >
    {children}
  </span>
);
