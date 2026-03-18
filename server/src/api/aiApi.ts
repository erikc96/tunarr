import type { RouterPluginAsyncCallback } from '@/types/serverType.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import {
  AiSettingsPublicSchema,
  AiSettingsSchema,
  AiGenerateChannelRequestSchema,
  AiRefreshChannelRequestSchema,
  AiAddProgramsRequestSchema,
  AiChatRequestSchema,
  AiTestConnectionResponseSchema,
  AiRecommendationSchema,
  ChannelSchema,
} from '@tunarr/types/schemas';
import { z } from 'zod/v4';
import { v4 } from 'uuid';
import { container } from '../container.js';
import { isContentItem } from '../db/derived_types/Lineup.js';
import { dbChannelToApiChannel } from '../db/converters/channelConverters.js';
import { TranscodeConfigDB } from '../db/TranscodeConfigDB.js';
import { GlobalScheduler } from '../services/Scheduler.js';
import { UpdateXmlTvTask } from '../tasks/UpdateXmlTvTask.js';
import { AiSettingsDB } from '../services/ai/AiSettingsDB.js';
import { AnthropicAdapter } from '../services/ai/AnthropicAdapter.js';
import { ChannelGenerator } from '../services/ai/ChannelGenerator.js';
import { ChannelRefresher } from '../services/ai/ChannelRefresher.js';
import { RecommendationEngine } from '../services/ai/RecommendationEngine.js';
import { ContextBuilder } from '../services/ai/ContextBuilder.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'AiApi',
});

export const aiApiRouter: RouterPluginAsyncCallback = async (fastify) => {
  // AI SETTINGS
  fastify.get(
    '/ai/settings',
    {
      schema: {
        tags: ['AI'],
        response: { 200: AiSettingsPublicSchema },
      },
    },
    async (_req, res) => {
      const db = container.get(AiSettingsDB);
      return res.send(await db.getPublic());
    },
  );

  fastify.put(
    '/ai/settings',
    {
      schema: {
        tags: ['AI'],
        body: AiSettingsSchema.partial(),
        response: { 200: AiSettingsPublicSchema },
      },
    },
    async (req, res) => {
      const db = container.get(AiSettingsDB);
      const result = await db.update(req.body);
      return res.send(result);
    },
  );

  fastify.post(
    '/ai/settings/test',
    {
      schema: {
        tags: ['AI'],
        response: { 200: AiTestConnectionResponseSchema },
      },
    },
    async (_req, res) => {
      const adapter = container.get(AnthropicAdapter);
      return res.send(await adapter.test());
    },
  );

  // CHANNEL GENERATION
  fastify.post(
    '/ai/generate-channel',
    {
      schema: {
        tags: ['AI'],
        body: AiGenerateChannelRequestSchema,
        response: {
          200: z.object({
            name: z.string(),
            number: z.number(),
            groupTitle: z.string(),
            programCount: z.number(),
            programUuids: z.string().array(),
            warnings: z.string().array(),
          }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      try {
        const generator = container.get(ChannelGenerator);
        const channels = await req.serverCtx.channelDB.getAllChannels();
        const existingChannels = channels.map((c) => ({
          number: c.number,
          name: c.name,
        }));
        const result = await generator.generate(
          req.body.prompt,
          existingChannels,
        );
        if ('error' in result) {
          return res.status(500).send({ error: result.error });
        }
        return res.send({
          ...result,
          programCount: result.programUuids.length,
        });
      } catch (err: unknown) {
        logger.error(err, 'Error generating channel');
        return res
          .status(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // APPLY CHANNEL (generate + create + populate lineup)
  fastify.post(
    '/ai/apply-channel',
    {
      schema: {
        tags: ['AI'],
        body: AiGenerateChannelRequestSchema,
        response: {
          201: ChannelSchema,
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      try {
        const generator = container.get(ChannelGenerator);
        const channels = await req.serverCtx.channelDB.getAllChannels();
        const existingChannels = channels.map((c) => ({
          number: c.number,
          name: c.name,
        }));

        const proposal = await generator.generate(
          req.body.prompt,
          existingChannels,
        );

        if ('error' in proposal) {
          return res.status(500).send({ error: proposal.error });
        }

        if (proposal.programUuids.length === 0) {
          return res
            .status(500)
            .send({ error: 'No matching programs found for this prompt' });
        }

        const transcodeDB = container.get(TranscodeConfigDB);
        const defaultConfig = await transcodeDB.getDefaultConfig();
        if (!defaultConfig) {
          return res
            .status(500)
            .send({ error: 'No default transcode config found' });
        }

        const channelId = v4();
        const now = Date.now();

        const saved = await req.serverCtx.channelDB.saveChannel({
          id: channelId,
          name: proposal.name,
          number: proposal.number,
          groupTitle: proposal.groupTitle,
          startTime: now,
          duration: 0,
          offline: { mode: 'pic' },
          guideMinimumDuration: 30000,
          icon: { path: '', width: 0, duration: 0, position: 'bottom-right' },
          disableFillerOverlay: false,
          stealth: false,
          streamMode: 'hls',
          transcodeConfigId: defaultConfig.uuid,
          subtitlesEnabled: false,
        });

        const programs = await req.serverCtx.programDB.getProgramsByIds(
          proposal.programUuids,
        );
        const durationByUuid = new Map(
          programs.map((p) => [p.uuid, p.duration]),
        );

        // Build lineup: manual type with persisted items.
        // Structured so schedule-based types can replace this later.
        const lineupItems = proposal.programUuids
          .filter((uuid) => durationByUuid.has(uuid))
          .map((uuid) => ({
            type: 'persisted' as const,
            programId: uuid,
            duration: durationByUuid.get(uuid)!,
          }));

        await req.serverCtx.channelDB.updateLineup(saved.channel.uuid, {
          type: 'manual',
          programs: [],
          lineup: lineupItems,
          append: false,
        });

        // Store the prompt so the AI schedule task can replenish this channel
        await req.serverCtx.channelDB.updateLineupConfig(
          saved.channel.uuid,
          'aiConfig',
          { prompt: req.body.prompt, lastScheduled: Date.now() },
        );

        GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
          .runNow(true)
          .catch((err) => logger.error(err, 'Error regenerating guide'));
        await req.serverCtx.m3uService.regenerateCache();

        const channelAndLineup =
          await req.serverCtx.channelDB.loadChannelAndLineup(
            saved.channel.uuid,
          );

        if (!channelAndLineup) {
          return res.status(500).send({ error: 'Channel created but failed to reload' });
        }

        return res.status(201).send(dbChannelToApiChannel(channelAndLineup));
      } catch (err: unknown) {
        logger.error(err, 'Error applying channel');
        return res
          .status(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // CHANNEL REFRESH
  fastify.post(
    '/ai/refresh-channel',
    {
      schema: {
        tags: ['AI'],
        body: AiRefreshChannelRequestSchema,
        response: {
          200: z.object({
            newProgramUuids: z.string().array(),
            warnings: z.string().array(),
          }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      try {
        const channel = await req.serverCtx.channelDB.getChannel(
          req.body.channelId,
        );
        if (!channel) {
          return res.status(404).send({ error: 'Channel not found' });
        }

        const lineup = await req.serverCtx.channelDB.loadLineup(channel.uuid);
        const programUuids = (lineup?.items ?? [])
          .filter(isContentItem)
          .map((i) => i.id);

        const shows: Record<string, number> = {};
        const programs = await req.serverCtx.programDB.getProgramsByIds(
          programUuids.slice(0, 1000),
        );
        for (const p of programs) {
          if (p.showTitle) {
            shows[p.showTitle] = (shows[p.showTitle] ?? 0) + 1;
          }
        }

        const refresher = container.get(ChannelRefresher);
        const result = await refresher.refresh({
          id: channel.uuid,
          name: channel.name,
          number: channel.number,
          programUuids,
          shows,
        });

        return res.send(result);
      } catch (err: unknown) {
        logger.error(err, 'Error refreshing channel');
        return res
          .status(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ADD PROGRAMS BY PROMPT
  fastify.post(
    '/ai/add-programs',
    {
      schema: {
        tags: ['AI'],
        body: AiAddProgramsRequestSchema,
        response: {
          200: z.object({
            newProgramUuids: z.string().array(),
            warnings: z.string().array(),
          }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      try {
        const channel = await req.serverCtx.channelDB.getChannel(
          req.body.channelId,
        );
        if (!channel) {
          return res.status(404).send({ error: 'Channel not found' });
        }

        const lineup = await req.serverCtx.channelDB.loadLineup(channel.uuid);
        const programUuids = (lineup?.items ?? [])
          .filter(isContentItem)
          .map((i) => i.id);

        const shows: Record<string, number> = {};
        const programs = await req.serverCtx.programDB.getProgramsByIds(
          programUuids.slice(0, 1000),
        );
        for (const p of programs) {
          if (p.showTitle) {
            shows[p.showTitle] = (shows[p.showTitle] ?? 0) + 1;
          }
        }

        const refresher = container.get(ChannelRefresher);
        const result = await refresher.addByPrompt(
          {
            id: channel.uuid,
            name: channel.name,
            number: channel.number,
            programUuids,
            shows,
          },
          req.body.prompt,
        );

        return res.send(result);
      } catch (err: unknown) {
        logger.error(err, 'Error adding programs');
        return res
          .status(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // CHAT
  fastify.post(
    '/ai/chat',
    {
      schema: {
        tags: ['AI'],
        body: AiChatRequestSchema,
        response: {
          200: z.object({ message: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      try {
        const adapter = container.get(AnthropicAdapter);
        const ctx = container.get(ContextBuilder);
        const stats = await ctx.getStats();

        const channels = await req.serverCtx.channelDB.getAllChannels();
        const channelList = channels
          .map((c) => `#${c.number}: ${c.name}`)
          .join('\n');

        const systemPrompt = [
          'You are a TV channel curator for Tunarr. You help manage TV channels from a media library.',
          '\nLibrary overview:\n' + stats,
          channelList ? '\n\nExisting channels:\n' + channelList : '',
        ].join('\n');

        const fullMessages = [
          { role: 'system' as const, content: systemPrompt },
          ...req.body.messages,
        ];

        const response = await adapter.complete(fullMessages, {
          temperature: 0.7,
        });
        return res.send({ message: response });
      } catch (err: unknown) {
        logger.error(err, 'Error in AI chat');
        return res
          .status(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // CHANNEL AI PROMPT
  fastify.get(
    '/ai/channel/:channelId/prompt',
    {
      schema: {
        tags: ['AI'],
        params: z.object({ channelId: z.string() }),
        response: {
          200: z.object({ prompt: z.string().nullable() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannel(
        req.params.channelId,
      );
      if (!channel) {
        return res.status(404).send({ error: 'Channel not found' });
      }
      const lineup = await req.serverCtx.channelDB.loadLineup(channel.uuid);
      return res.send({ prompt: lineup.aiConfig?.prompt ?? null });
    },
  );

  fastify.put(
    '/ai/channel/:channelId/prompt',
    {
      schema: {
        tags: ['AI'],
        params: z.object({ channelId: z.string() }),
        body: z.object({ prompt: z.string().nullable() }),
        response: {
          200: z.object({ prompt: z.string().nullable() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannel(
        req.params.channelId,
      );
      if (!channel) {
        return res.status(404).send({ error: 'Channel not found' });
      }
      if (req.body.prompt) {
        await req.serverCtx.channelDB.updateLineupConfig(
          channel.uuid,
          'aiConfig',
          { prompt: req.body.prompt },
        );
      } else {
        await req.serverCtx.channelDB.updateLineupConfig(
          channel.uuid,
          'aiConfig',
          undefined,
        );
      }
      return res.send({ prompt: req.body.prompt });
    },
  );

  // RECOMMENDATIONS
  fastify.get(
    '/ai/recommendations',
    {
      schema: {
        tags: ['AI'],
        response: {
          200: z.object({
            recommendations: AiRecommendationSchema.array(),
          }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      try {
        const engine = container.get(RecommendationEngine);
        const channels = await req.serverCtx.channelDB.getAllChannels();

        const channelInfos = await Promise.all(
          channels.map(async (ch) => {
            const lineup = await req.serverCtx.channelDB.loadLineup(ch.uuid);
            const programUuids = (lineup?.items ?? [])
              .filter(isContentItem)
              .map((i) => i.id);

            const programs = await req.serverCtx.programDB.getProgramsByIds(
              programUuids.slice(0, 500),
            );
            const shows: Record<string, number> = {};
            for (const p of programs) {
              if (p.showTitle) {
                shows[p.showTitle] = (shows[p.showTitle] ?? 0) + 1;
              }
            }

            return {
              id: ch.uuid,
              number: ch.number,
              name: ch.name,
              programCount: programUuids.length,
              durationHours: Math.round(ch.duration / 3600000),
              topShows: Object.entries(shows)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([s]) => s),
            };
          }),
        );

        const result = await engine.getRecommendations(channelInfos);
        if ('error' in result) {
          return res.status(500).send({ error: result.error });
        }
        return res.send(result);
      } catch (err: unknown) {
        logger.error(err, 'Error getting recommendations');
        return res
          .status(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
};
