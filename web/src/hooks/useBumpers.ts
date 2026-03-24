import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import useStore from '../store/index.ts';

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
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface BumperFile {
  filename: string;
  path: string;
  durationMs: number;
  programUuid: string;
}

export interface BumperPack {
  id: string;
  name: string;
  directory: string;
  mediaSourceUuid: string;
  files: BumperFile[];
  createdAt: string;
  updatedAt: string;
}

const bumperKeys = {
  packs: ['bumpers', 'packs'] as const,
  pack: (id: string) => ['bumpers', 'packs', id] as const,
};

export const useBumperPacks = () =>
  useQuery({
    queryKey: bumperKeys.packs,
    queryFn: () => apiFetch<BumperPack[]>('/bumpers/packs'),
  });

export const useCreateBumperPack = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; directory: string }) =>
      apiFetch<BumperPack>('/bumpers/packs', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bumperKeys.packs });
    },
  });
};

export const useRescanBumperPack = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (packId: string) =>
      apiFetch<BumperPack>(`/bumpers/packs/${packId}/rescan`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bumperKeys.packs });
    },
  });
};

export const useDeleteBumperPack = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (packId: string) =>
      apiFetch<void>(`/bumpers/packs/${packId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bumperKeys.packs });
    },
  });
};
