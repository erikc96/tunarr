import z from 'zod/v4';

export const AiSettingsSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('claude-sonnet-4-20250514'),
  enabled: z.boolean().default(false),
  autoScanEnabled: z.boolean().default(false),
  autoScanIntervalMinutes: z.number().min(5).max(1440).default(30),
});

export type AiSettings = z.infer<typeof AiSettingsSchema>;

export const AiSettingsPublicSchema = z.object({
  model: z.string(),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  autoScanEnabled: z.boolean(),
  autoScanIntervalMinutes: z.number(),
});

export type AiSettingsPublic = z.infer<typeof AiSettingsPublicSchema>;

export const AiSelectionSchema = z.object({
  type: z.enum(['show', 'movie']),
  title: z.string(),
  ratingKey: z.string().optional(),
});

export type AiSelection = z.infer<typeof AiSelectionSchema>;

export const AiRecommendationSchema = z.object({
  type: z.enum([
    'new-channel',
    'schedule-improvement',
    'content-addition',
    'gap-analysis',
  ]),
  title: z.string(),
  description: z.string(),
  actionPrompt: z.string(),
  targetChannel: z.number().nullable().optional(),
  items: z.string().array().optional(),
});

export type AiRecommendation = z.infer<typeof AiRecommendationSchema>;

export const AiGenerateChannelRequestSchema = z.object({
  prompt: z.string().min(1),
});

export const AiRefreshChannelRequestSchema = z.object({
  channelId: z.string().min(1),
});

export const AiAddProgramsRequestSchema = z.object({
  channelId: z.string().min(1),
  prompt: z.string().min(1),
});

export const AiApplyProgramsRequestSchema = z.object({
  channelId: z.string().min(1),
  programIds: z.string().array(),
});

export const AiChatRequestSchema = z.object({
  messages: z
    .object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    })
    .array(),
});

export const AiTestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  model: z.string().optional(),
  error: z.string().optional(),
});
