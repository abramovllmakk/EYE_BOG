import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, type Run, type SchemaModel } from '../lib/api';
import { dateTime, runLabel } from '../lib/format';
import { Icon } from './icons';

interface Item {
  id: string;
  group: string;
  label: string;
  detail?: string;
  to: string;
}

const PAGES: [string, string, boolean][] = [
  ['/graph', 'Карта схемы', true],
  ['/table', 'Таблица покрытия', true],
  ['/plan', 'План покрытия', true],
  ['/tests', 'Вклад тестов', true],
  ['/heatmap', 'Heatmap', true],
  ['/operations', 'Запросы тестов', true],
  ['/', 'Прогоны', false],
  ['/compare', 'Сравнение прогонов', false],
  ['/timeline', 'Динамика', false],
  ['/teams', 'Команды', false],
];

/** Ctrl/⌘+K: jump to any screen, type, field or run. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [params] = useSearchParams();
  const run = params.get('run') ?? '';
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const schema = useQuery({
    queryKey: ['schema', run],
    queryFn: () => api<SchemaModel>(`/api/runs/${encodeURIComponent(run)}/schema`),
    enabled: open && !!run,
  });
  const runs = useQuery({
    queryKey: ['runs', 'picker'],
    queryFn: () => api<{ items: Run[] }>('/api/runs?limit=100'),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const all = useMemo<Item[]>(() => {
    const withRun = (path: string, r = run) => (r ? `${path}?run=${encodeURIComponent(r)}` : path);
    const out: Item[] = PAGES.filter(([, , needsRun]) => !needsRun || run).map(([to, label]) => ({
      id: `page:${to}`,
      group: 'Разделы',
      label,
      to: withRun(to),
    }));
    for (const t of schema.data?.types ?? []) {
      if (t.builtIn || t.kind === 'SCALAR') continue;
      out.push({
        id: `type:${t.name}`,
        group: 'Типы',
        label: t.name,
        detail: t.kind.toLowerCase(),
        to: withRun(`/types/${t.name}`),
      });
      for (const f of t.fields)
        out.push({
          id: `field:${f.coordinate}`,
          group: 'Поля',
          label: f.coordinate,
          detail: f.type,
          to: withRun(`/fields/${f.coordinate}`),
        });
    }
    for (const r of runs.data?.items ?? [])
      out.push({
        id: `run:${r.id}`,
        group: 'Прогоны',
        label: runLabel(r),
        detail: dateTime(r.startedAt),
        to: withRun('/graph', r.id),
      });
    return out;
  }, [schema.data, runs.data, run]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return all.filter((i) => i.group === 'Разделы' || i.group === 'Прогоны').slice(0, 14);
    const score = (i: Item) => {
      const l = i.label.toLowerCase();
      const name = l.slice(l.lastIndexOf('.') + 1);
      if (name === s || l === s) return 0;
      if (name.startsWith(s) || l.startsWith(s)) return 1;
      return l.includes(s) ? 2 : 9;
    };
    return all
      .map((i) => [score(i), i] as const)
      .filter(([sc]) => sc < 9)
      .sort((a, b) => a[0] - b[0] || a[1].label.length - b[1].label.length)
      .slice(0, 30)
      .map(([, i]) => i);
  }, [q, all]);

  if (!open) return null;
  const go = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    nav(i.to);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Быстрый переход"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <svg
            viewBox="0 0 20 20"
            className="size-[18px] text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden
          >
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.2 13.2 3.8 3.8" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') go(results[active]);
              else if (e.key === 'Escape') onClose();
            }}
            placeholder={run ? 'Раздел, тип, поле или прогон' : 'Раздел или прогон'}
            aria-label="Поиск"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[active] ? `pal-${active}` : undefined}
            className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted focus-visible:outline-none"
          />
          <kbd className="rounded border border-line px-1.5 text-xs text-muted">Esc</kbd>
        </div>
        <ul id="palette-results" role="listbox" className="max-h-[50vh] overflow-auto p-2">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-muted">Ничего не найдено</li>
          )}
          {results.map((i, n) => (
            <li
              key={i.id}
              id={`pal-${n}`}
              role="option"
              aria-selected={n === active}
              onMouseEnter={() => setActive(n)}
              onClick={() => go(i)}
              className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 ${n === active ? 'bg-surface-2' : ''}`}
            >
              <span className="w-16 shrink-0 text-xs text-muted">{i.group}</span>
              <span
                className={`min-w-0 truncate ${i.group === 'Поля' || i.group === 'Типы' ? 'font-mono text-[13px]' : ''}`}
              >
                {i.label}
              </span>
              {i.detail && (
                <span className="ml-auto shrink-0 truncate text-xs text-muted">{i.detail}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Sidebar button that opens the palette; also binds Ctrl/⌘+K globally. */
export function SearchButton({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-9 w-full items-center gap-2.5 rounded-md border border-line bg-surface-2 px-2.5 text-muted hover:text-ink"
    >
      <Icon.search />
      Поиск
      <kbd className="ml-auto rounded border border-line px-1.5 text-xs">
        {mac ? '⌘K' : 'Ctrl K'}
      </kbd>
    </button>
  );
}
