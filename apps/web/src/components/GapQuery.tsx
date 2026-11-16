import { useState } from 'react';
import { Link } from 'react-router';
import type { GapSuggestion } from '../lib/api';
import { copyText, curlSnippet, fetchSnippet } from '../lib/plan';
import { useRunLink } from '../lib/url';
import { QueryView } from './QueryView';
import { Mono } from './ui';

export function CopyButton({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState<null | boolean>(null);
  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm hover:bg-surface-2"
      onClick={async () => {
        setDone(await copyText(text));
        window.setTimeout(() => setDone(null), 1600);
      }}
    >
      <svg
        viewBox="0 0 16 16"
        className="size-3.5"
        aria-hidden
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        {done ? (
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
            <path d="M3 10.5V3.8C3 3.36 3.36 3 3.8 3h6.7" strokeLinecap="round" />
          </>
        )}
      </svg>
      <span aria-live="polite">{done === null ? label : done ? 'Скопировано' : 'Не удалось'}</span>
    </button>
  );
}

/** One suggested operation: query, sample variables and copy-ready test snippets. */
export function GapQuery({
  s,
  proxyUrl,
  compact = false,
}: {
  s: GapSuggestion;
  proxyUrl: string;
  compact?: boolean;
}) {
  const link = useRunLink();
  const hasVars = Object.keys(s.variables).length > 0;
  return (
    <div className="flex flex-col gap-3">
      {!compact && (
        <p className="text-muted">
          Покрывает:{' '}
          {s.fields.map((f, i) => (
            <span key={f}>
              {i > 0 && ', '}
              <Link to={link(`/fields/${f}`)} className="text-ink hover:underline">
                <Mono>{f}</Mono>
              </Link>
            </span>
          ))}
          {s.gain.length > s.fields.length && (
            <> и попутно ещё {s.gain.length - s.fields.length} по пути</>
          )}
          .
        </p>
      )}
      <QueryView text={s.query} />
      {hasVars && (
        <div>
          <div className="mb-1 text-xs text-muted">
            Переменные: примерные значения, подставьте данные со стенда
          </div>
          <QueryView text={JSON.stringify(s.variables, null, 2)} />
        </div>
      )}
      {s.deprecated.length > 0 && (
        <p className="rounded-md border border-partial/50 bg-partial-soft px-3 py-2 text-sm">
          Устаревшие поля (@deprecated): <Mono>{s.deprecated.join(', ')}</Mono>. Покрывайте их новым
          тестом, только если они ещё поддерживаются, иначе уберите их из запроса.
        </p>
      )}
      {s.operationType === 'subscription' && (
        <p className="text-xs text-muted">
          Подписку отправляйте через WebSocket на тот же адрес прокси (graphql-transport-ws).
        </p>
      )}
      {s.operationType === 'mutation' && (
        <p className="text-xs text-muted">
          Мутация меняет данные: запускайте на тестовом стенде с подготовленными записями.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <CopyButton label="Запрос" text={s.query} />
        {hasVars && <CopyButton label="Переменные" text={JSON.stringify(s.variables, null, 2)} />}
        {s.operationType !== 'subscription' && (
          <>
            <CopyButton label="curl" text={curlSnippet(s, proxyUrl)} />
            <CopyButton label="Тест на fetch" text={fetchSnippet(s, proxyUrl)} />
          </>
        )}
      </div>
    </div>
  );
}
