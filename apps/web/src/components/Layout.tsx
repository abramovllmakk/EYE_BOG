import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useSearchParams } from 'react-router';
import { api, getToken, setToken, ApiError, type Run } from '../lib/api';
import { dateTime, runLabel } from '../lib/format';
import { useRunLink } from '../lib/url';
import { CommandPalette, SearchButton } from './CommandPalette';
import { EyeMark, Icon } from './icons';

type NavItem = { to: string; label: string; icon: keyof typeof Icon };
const RUN_NAV: NavItem[] = [
  { to: '/graph', label: 'Карта схемы', icon: 'map' },
  { to: '/table', label: 'Таблица покрытия', icon: 'table' },
  { to: '/plan', label: 'План покрытия', icon: 'plan' },
  { to: '/tests', label: 'Вклад тестов', icon: 'tests' },
  { to: '/heatmap', label: 'Heatmap', icon: 'heat' },
  { to: '/operations', label: 'Запросы тестов', icon: 'requests' },
];
const ALL_NAV: NavItem[] = [
  { to: '/', label: 'Прогоны', icon: 'runs' },
  { to: '/compare', label: 'Сравнение', icon: 'compare' },
  { to: '/timeline', label: 'Динамика', icon: 'timeline' },
  { to: '/teams', label: 'Команды', icon: 'teams' },
];

/** Dark on every visit; the button flips to light for the current page session only. */
function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const Glyph = theme === 'dark' ? Icon.sun : Icon.moon;
  return (
    <button
      type="button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-muted hover:bg-surface-2 hover:text-ink"
    >
      <Glyph />
      {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
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
    <label className="flex flex-col gap-1.5 text-xs text-muted">
      Прогон
      <select
        aria-label="Прогон"
        value={runId}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          if (e.target.value) next.set('run', e.target.value);
          else next.delete('run');
          setParams(next);
        }}
        className="h-9 w-full rounded-md border border-line bg-surface-2 px-2 text-sm text-ink"
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
      <button className="mt-3 h-9 w-full rounded-md bg-accent font-medium text-on-accent">
        Войти
      </button>
    </form>
  );
}

function NavGroup({
  title,
  items,
  onNavigate,
}: {
  title: string;
  items: NavItem[];
  onNavigate: () => void;
}) {
  const link = useRunLink();
  return (
    <div>
      <div className="px-2.5 pb-1.5 text-xs text-muted">{title}</div>
      <ul className="flex flex-col gap-0.5">
        {items.map((n) => {
          const Glyph = Icon[n.icon];
          return (
            <li key={n.to}>
              <NavLink
                to={link(n.to)}
                end={n.to === '/'}
                onClick={onNavigate}

                className={({ isActive }) =>
                  `relative flex h-9 items-center gap-2.5 rounded-md px-2.5 ${
                    isActive
                      ? 'bg-surface-2 font-medium text-ink before:absolute before:inset-y-2 before:-left-3 before:w-0.5 before:rounded-full before:bg-covered'
                      : 'text-muted hover:bg-surface-2 hover:text-ink'
                  }`
                }
              >
                <Glyph />
                {n.label}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Brand() {
  const link = useRunLink();
  return (
    <NavLink to={link('/')} className="flex items-center gap-2.5">
      <EyeMark />
      <span className="leading-tight">
        <span className="block font-semibold tracking-tight">Сеть глазами Бога</span>
        <span className="block text-xs text-muted">карта покрытия GraphQL</span>
      </span>
    </NavLink>
  );
}

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const probe = useQuery({
    queryKey: ['targets'],
    queryFn: () => api('/api/targets'),
    retry: false,
  });
  if (probe.error instanceof ApiError && probe.error.status === 401) return <TokenPrompt />;
  const close = () => setMenuOpen(false);
  return (
    <div className="flex h-full flex-col md:flex-row">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 md:hidden">
        <Brand />
        <button
          type="button"
          className="ml-auto flex size-9 items-center justify-center rounded-md border border-line"
          aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <Icon.close /> : <Icon.menu />}
        </button>
      </header>
      <aside
        className={`${menuOpen ? 'flex' : 'hidden'} min-h-0 shrink-0 flex-col gap-6 overflow-y-auto border-line bg-surface px-3 py-4 max-md:absolute max-md:inset-x-0 max-md:top-[57px] max-md:bottom-0 max-md:z-30 max-md:border-t md:flex md:w-64 md:border-r`}
        aria-label="Навигация"
      >
        <div className="hidden px-1 md:block">
          <Brand />
        </div>
        <div className="flex flex-col gap-3 px-1">
          <SearchButton onOpen={openPalette} />
          <RunPicker />
        </div>
        <nav className="flex flex-col gap-5 pl-1" aria-label="Разделы">
          <NavGroup
            title="Покрытие прогона"
            items={RUN_NAV}

            onNavigate={close}
          />
          <NavGroup title="Все прогоны" items={ALL_NAV} onNavigate={close} />
        </nav>
        <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-3 pl-1">
          <NavLink
            to="/connect"
            onClick={close}
            className={({ isActive }) =>
              `flex h-9 items-center gap-2.5 rounded-md px-2.5 ${isActive ? 'bg-surface-2 text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink'}`
            }
          >
            <Icon.plug />
            Подключение тестов
          </NavLink>
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-muted hover:bg-surface-2 hover:text-ink"
          >
            <Icon.docs />
            REST API и OpenAPI
          </a>
          <ThemeToggle />
        </div>
      </aside>
      <main className="relative min-h-0 min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

/**
 * Shown by run-scoped screens when the URL has no run: opens the latest run instead of a dead end,
 * and only asks to pick one when there are no runs yet.
 */
export function NeedRun() {
  const [, setParams] = useSearchParams();
  const latest = useQuery({
    queryKey: ['runs', 'latest'],
    queryFn: () => api<{ items: Run[] }>('/api/runs?limit=1'),
  });
  const id = latest.data?.items[0]?.id;
  useEffect(() => {
    if (id)
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('run', id);
          return next;
        },
        { replace: true },
      );
  }, [id, setParams]);
  if (latest.isLoading || id) return null;
  return (
    <div className="mx-auto my-16 max-w-xl rounded-lg border border-dashed border-line bg-surface px-6 py-8 text-center">
      <h2 className="text-base font-semibold">Прогонов пока нет</h2>
      <p className="mt-2 text-muted">
        Направьте автотесты на прокси: первый прогон появится после первого запроса.
      </p>
    </div>
  );
}
