import { z } from 'zod/v4';

/**
 * A time-of-day block for dual-mode scheduling (e.g., Cartoon Network by day / Adult Swim by night).
 * startHour is inclusive, endHour is exclusive (24-hour clock).
 * Blocks should be contiguous and cover the full 24-hour day.
 */
export const DayBlockSchema = z.object({
  label: z.string().min(1),
  // 0–23 (inclusive start)
  startHour: z.number().int().min(0).max(23),
  // 1–24 (exclusive end; 24 = midnight next day)
  endHour: z.number().int().min(1).max(24),
  // Optional content filter: only include programs matching these tags/genres in this block
  contentTags: z.array(z.string()).optional(),
  // Optional genre filter applied during AI-driven replenishment
  genres: z.array(z.string()).optional(),
});

export type DayBlock = z.infer<typeof DayBlockSchema>;

/**
 * Channel-level block schedule config. Stored in lineup `aiConfig`.
 * Tells the AI how to distribute content by time of day.
 */
export const BlockScheduleConfigSchema = z.object({
  enabled: z.boolean().default(false),
  blocks: z.array(DayBlockSchema).min(2),
});

export type BlockScheduleConfig = z.infer<typeof BlockScheduleConfigSchema>;
