import { z } from 'zod/v4';

export const BumperFileSchema = z.object({
  filename: z.string(),
  path: z.string(),
  durationMs: z.number().int().positive(),
  programUuid: z.string().uuid(),
});

export type BumperFile = z.infer<typeof BumperFileSchema>;

export const BumperPackSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  directory: z.string(),
  mediaSourceUuid: z.string().uuid(),
  files: z.array(BumperFileSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type BumperPack = z.infer<typeof BumperPackSchema>;

export const ChannelBumperConfigSchema = z.object({
  packId: z.string().uuid(),
  // How many bumpers to insert per episode boundary (1 = every boundary, 2 = every other, etc.)
  frequencyPerEpisode: z.number().int().min(1).max(10).default(1),
  // 'between' = insert between episodes; 'within' = insert between episodes and at the start
  placement: z.enum(['between', 'within']).default('between'),
});

export type ChannelBumperConfig = z.infer<typeof ChannelBumperConfigSchema>;

export const BumperPackListSchema = z.array(BumperPackSchema);

export const CreateBumperPackRequestSchema = z.object({
  name: z.string().min(1),
  directory: z.string().min(1),
});

export type CreateBumperPackRequest = z.infer<
  typeof CreateBumperPackRequestSchema
>;
