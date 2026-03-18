import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import useStore from '../store/index.ts';

const baseUrl = () => useStore.getState().settings.backendUri;

async function apiFetch<T>(
  path: string,
  opts?: RequestInit,
): Promise<T> {
  const res = await fetch(`${baseUrl()}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface AiSettingsPublic {
  model: string;
  enabled: boolean;
  autoScanEnabled: boolean;
  autoScanIntervalMinutes: number;
  hasApiKey: boolean;
}

export interface AiRecommendation {
  type: 'new-channel' | 'schedule-improvement' | 'content-addition' | 'gap-analysis';
  title: string;
  description: string;
  actionPrompt: string;
  targetChannel: number | null;
  items?: string[];
}

export interface AiGenerateResult {
  name: string;
  number: number;
  groupTitle: string;
  programCount: number;
  programUuids: string[];
  warnings: string[];
}

export interface AiRefreshResult {
  newProgramUuids: string[];
  warnings: string[];
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Query keys
const aiKeys = {
  settings: ['ai', 'settings'] as const,
  recommendations: ['ai', 'recommendations'] as const,
};

export const useAiSettings = () =>
  useQuery({
    queryKey: aiKeys.settings,
    queryFn: () => apiFetch<AiSettingsPublic>('/ai/settings'),
  });

export const useUpdateAiSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      apiKey?: string;
      model?: string;
      enabled?: boolean;
      autoScanEnabled?: boolean;
      autoScanIntervalMinutes?: number;
    }) =>
      apiFetch<AiSettingsPublic>('/ai/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(aiKeys.settings, data);
    },
  });
};

export const useTestAiConnection = () =>
  useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; error?: string; model?: string }>('/ai/settings/test', {
        method: 'POST',
      }),
  });

export const useAiRecommendations = (enabled = true) =>
  useQuery({
    queryKey: aiKeys.recommendations,
    queryFn: () =>
      apiFetch<{ recommendations: AiRecommendation[] }>(
        '/ai/recommendations',
      ),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

export const useGenerateChannel = () =>
  useMutation({
    mutationFn: (prompt: string) =>
      apiFetch<AiGenerateResult>('/ai/generate-channel', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      }),
  });

export interface AiApplyChannelResult {
  id: string;
  name: string;
  number: number;
}

export const useApplyChannel = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prompt: string) =>
      apiFetch<AiApplyChannelResult>('/ai/apply-channel', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });
};

export const useRefreshChannel = () =>
  useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<AiRefreshResult>('/ai/refresh-channel', {
        method: 'POST',
        body: JSON.stringify({ channelId }),
      }),
  });

export const useAddPrograms = () =>
  useMutation({
    mutationFn: (body: { channelId: string; prompt: string }) =>
      apiFetch<AiRefreshResult>('/ai/add-programs', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });

export const useAiChat = () =>
  useMutation({
    mutationFn: (messages: AiChatMessage[]) =>
      apiFetch<{ message: string }>('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ messages }),
      }),
  });
