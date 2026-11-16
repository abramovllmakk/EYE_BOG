import { useQuery } from '@tanstack/react-query';
import { LIVE_INTERVAL_MS, useRunLive } from './live';
import { api, type GapPlan, type GapSuggestion, type Run, type Target } from './api';

/** Coverage plan of a run plus the proxy URL tests should call. */
export function usePlan(run: string) {
  const live = useRunLive(run);
  const plan = useQuery({
    queryKey: ['gaps', run],
    queryFn: () => api<GapPlan>(`/api/runs/${encodeURIComponent(run)}/gaps`),
    enabled: !!run,
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
  const runInfo = useQuery({
    queryKey: ['run', run],
    queryFn: () => api<Run>(`/api/runs/${encodeURIComponent(run)}`),
    enabled: !!run,
  });
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => api<Target[]>('/api/targets') });
  const target = targets.data?.find((t) => t.name === runInfo.data?.target);
  const proxyUrl = `${location.protocol}//${location.hostname}:4000${target?.proxyPath ?? '/graphql'}`;
  return { plan, proxyUrl };
}

/** Suggestions that select `coordinate` or any field of `typeName`. */
export const suggestionsFor = (plan: GapPlan | undefined, typeName: string, coordinate?: string) =>
  (plan?.suggestions ?? []).filter((s) =>
    coordinate ? s.gain.includes(coordinate) : s.target === typeName,
  );

const body = (s: GapSuggestion) =>
  JSON.stringify({ query: s.query, variables: s.variables, operationName: s.operationName });

export function curlSnippet(s: GapSuggestion, proxyUrl: string): string {
  return [
    `curl -s ${proxyUrl} \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H 'x-test-name: ${s.operationName}' \\`,
    `  --data '${body(s).replace(/'/g, "'\\''")}'`,
  ].join('\n');
}

export function fetchSnippet(s: GapSuggestion, proxyUrl: string): string {
  return `const res = await fetch('${proxyUrl}', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-test-name': '${s.operationName}' },
  body: JSON.stringify({
    query: \`${s.query.replace(/`/g, '\\`')}\`,
    variables: ${JSON.stringify(s.variables, null, 2).replace(/\n/g, '\n    ')},
  }),
});
const { data, errors } = await res.json();
expect(errors).toBeUndefined();`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
