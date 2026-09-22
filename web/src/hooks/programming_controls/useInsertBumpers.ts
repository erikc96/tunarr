import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import useStore from '../../store/index.ts';

const baseUrl = () => useStore.getState().settings.backendUri;

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface SchedulingOperation {
  type: string;
  id: string;
  [key: string]: unknown;
}

export const useSchedulingOperations = (channelId: string) =>
  useQuery({
    queryKey: ['channels', channelId, 'scheduling-operations'],
    queryFn: () =>
      apiFetch<{ operations: SchedulingOperation[] }>(
        `/channels/${channelId}/scheduling-operations`,
      ),
  });

export const useInsertBumpers = (channelId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (op: {
      packId: string;
      betweenCount?: number;
      withinInterruptCount?: number;
    } | null) => {
      // Fetch current operations and replace any existing insert_bumpers op
      const current = await apiFetch<{ operations: SchedulingOperation[] }>(
        `/channels/${channelId}/scheduling-operations`,
      );
      const without = current.operations.filter(
        (o) => o.id !== 'insert_bumpers',
      );
      const next =
        op === null
          ? without
          : [
              ...without,
              {
                type: 'modifier' as const,
                id: 'insert_bumpers' as const,
                packId: op.packId,
                ...(op.betweenCount != null ? { betweenCount: op.betweenCount } : {}),
                ...(op.withinInterruptCount != null ? { withinInterruptCount: op.withinInterruptCount } : {}),
                allowMultiple: false,
              },
            ];
      return apiFetch<{ operations: SchedulingOperation[] }>(
        `/channels/${channelId}/scheduling-operations`,
        { method: 'PUT', body: JSON.stringify({ operations: next }) },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['channels', channelId, 'scheduling-operations'],
      });
    },
  });
};
