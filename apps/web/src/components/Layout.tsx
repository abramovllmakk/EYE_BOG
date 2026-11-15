import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useSearchParams } from 'react-router';
import { api, getToken, setToken, ApiError, type Run } from '../lib/api';
import { dateTime, runLabel } from '../lib/format';
import { useRunLink } from '../lib/url';

const NAV = [
  { to: '/', label: 'Прогоны', needsRun: false },
  { to: '/graph', label: 'Граф', needsRun: true },
  { to: '/table', label: 'Таблица', needsRun: true },
  { to: '/heatmap', label: 'Heatmap', needsRun: true },
  { to: '/operations', label: 'Запросы', needsRun: true },
  { to: '/compare', label: 'Сравнение', needsRun: false },
  { to: '/timeline', label: 'Динамика', needsRun: false },
];

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '');
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem('gqlcov-theme', theme);
      else localStorage.removeItem('gqlcov-theme');
    } catch {
      /* ignore */
    }
  }, [theme]);
  const next = theme === '' ? 'dark' : theme === 'dark' ? 'light' : '';
  const label = theme === 'dark' ? 'Тёмная' : theme === 'light' ? 'Светлая' : 'Системная';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="h-8 rounded-md border border-line px-2.5 text-sm hover:bg-surface-2"
      title="Переключить тему"
    >
      Тема: {label}
    </button>
  );
}

function RunPicker() {
  const [params, setParams] = useSearchParams();
  const runId = params.get('run') ?? '';
  const runs = useQuery({
    queryKey: ['runs', 'picker'],
    queryFn: () => api<{ items: Run[] }>('/api/runs?limit=100'),
    refetchInterval: 10_000,
  });
  const items = runs.data?.items ?? [];
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">Прогон</span>
      <select
        aria-label="Прогон"
        value={runId}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          if (e.target.value) next.set('run', e.target.value);
          else next.delete('run');
          setParams(next);
        }}
        className="h-8 max-w-72 rounded-md border border-line bg-surface px-2"
      >
        <option value="">не выбран</option>
        {runId && !items.some((r) => r.id === runId) && <option value={runId}>{runId}</option>}
        {items.map((r) => (
          <option key={r.id} value={r.id}>
            {runLabel(r)} ({dateTime(r.startedAt)}){r.status === 'running' ? ' (идёт)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function TokenPrompt() {
  const [value, setValue] = useState(getToken() ?? '');
  return (
    <form
      className="mx-auto mt-24 max-w-sm rounded-lg border border-line bg-surface p-6"
      onSubmit={(e) => {
        e.preventDefault();
        setToken(value);
        location.reload();
      }}
    >
      <h1 className="text-base font-semibold">Нужен токен доступа</h1>
      <p className="mt-1 text-muted">API защищён токеном (параметр auth.token в конфиге).</p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="mt-4 h-9 w-full rounded-md border border-line bg-surface-2 px-2"
        aria-label="Токен"
      />
      <button className="mt-3 h-9 w-full rounded-md bg-accent text-white">Войти</button>
    </form>
  );
}

export function Layout() {
  const link = useRunLink();
  const [params] = useSearchParams();
  const hasRun = !!params.get('run');
  const probe = useQuery({
    queryKey: ['targets'],
    queryFn: () => api('/api/targets'),
    retry: false,
  });
  if (probe.error instanceof ApiError && probe.error.status === 401) return <TokenPrompt />;
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-4 py-2">
        <NavLink to={link('/')} className="flex items-center gap-2 font-semibold">
          <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
            <circle
              cx="16"
              cy="16"
              r="13"
              fill="none"
              stroke="var(--covered)"
              strokeWidth="4"
              strokeDasharray="56 82"
            />
            <circle cx="16" cy="16" r="4" fill="var(--accent)" />
          </svg>
          GraphQL Coverage
        </NavLink>
        <nav className="flex flex-wrap gap-1" aria-label="Разделы">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={link(n.to)}
              end={n.to === '/'}
              aria-disabled={n.needsRun && !hasRun}
              className={({ isActive }) =>
                `rounded-md px-2.5 py-1.5 ${isActive ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-surface-2'} ${n.needsRun && !hasRun ? 'opacity-50' : ''}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <RunPicker />
          <ThemeToggle />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

/** Shown by run-scoped screens when no run is selected. */
export function NeedRun() {
  return (
    <div className="mx-auto my-16 max-w-xl rounded-lg border border-dashed border-line bg-surface px-6 py-8 text-center">
      <h2 className="text-base font-semibold">Выберите прогон</h2>
      <p className="mt-2 text-muted">
        Выберите прогон в селекторе сверху или на вкладке «Прогоны».
      </p>
    </div>
  );
}
