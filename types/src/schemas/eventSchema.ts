import { z } from 'zod/v4';
import {
  ChannelConcatStreamModes,
  ChannelStreamModes,
} from './channelSchema.js';

export const EventTypeSchema = z.union([
  z.literal('heartbeat'),
  z.literal('lifecycle'),
  z.literal('xmltv'),
  z.literal('settings-update'),
]);

const BaseEventSchema = z.object({
  message: z.string().optional(),
  level: z.enum(['info', 'success', 'warning', 'error']),
});

export const SettingsUpdateEventSchema = BaseEventSchema.extend({
  type: z.literal('settings-update'),
  module: z.string(),
  detail: z.object({
    action: z.enum(['reset', 'update', 'action', 'delete', 'add']),
    error: z.string().optional(),
    serverName: z.string().optional(),
    serverId: z.string().optional(),
  }),
});

export const HeartbeatEventSchema = BaseEventSchema.extend({
  type: z.literal('heartbeat'),
});

export const XmlTvEventSchema = BaseEventSchema.extend({
  type: z.literal('xmltv'),
  module: z.string(),
  detail: z.object({
    time: z.number(),
  }),
});

export const LifecycleEventSchema = BaseEventSchema.extend({
  type: z.literal('lifecycle'),
  detail: z.object({
    time: z.number(),
  }),
});

export const StreamSessionEventSchema = BaseEventSchema.extend({
  type: z.literal('stream'),
  action: z.enum([
    'start',
    'connection_add',
    'connection_remove',
    'end',
    'error',
  ]),
  details: z.object({
    channelId: z.string().uuid(),
    sessionType: z.union([
      z.enum([...ChannelStreamModes, ...ChannelConcatStreamModes]),
      z.templateLiteral([
        z.enum(ChannelConcatStreamModes),
        z.enum(['_low', '_fire']),
      ]),
      // Reduced-size transcodes and the wrappers that serve them.
      z.templateLiteral(['hls~', z.enum(['480p', '720p'])]),
      z.templateLiteral(['hls~', z.enum(['480p', '720p']), '_concat']),
    ]),
  }),
});

export const TunarrEventSchema = z.discriminatedUnion('type', [
  SettingsUpdateEventSchema,
  HeartbeatEventSchema,
  LifecycleEventSchema,
  XmlTvEventSchema,
  StreamSessionEventSchema,
]);
