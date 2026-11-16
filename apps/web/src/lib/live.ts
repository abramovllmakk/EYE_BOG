import { useQuery } from '@tanstack/react-query';
import { api, type Run } from './api';

export const LIVE_INTERVAL_MS = 3000;

/** True while the run is still receiving traffic; run-scoped screens then poll for updates. */
export function useRunLive(run: string): boolean {
  const q = useQuery({
    queryKey: ['run', run],
    queryFn: () => api<Run>(`/api/runs/${encodeURIComponent(run)}`),
    enabled: !!run,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? LIVE_INTERVAL_MS : false),
  });
  return q.data?.status === 'running';
}
