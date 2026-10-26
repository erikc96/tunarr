import type { Channel } from '@/db/schema/Channel.js';
import type { BaseHlsSession } from '@/stream/hls/BaseHlsSession.js';
import type { ConcatSessionOptions } from '@/stream/ConcatSession.js';
import { fanOut } from '@/stream/fanOut.js';
import { parseBasicAuth } from '@/stream/basicAuth.js';
import {
  isReducedProfile,
  QualityProfileNames,
  resolveProfile,
  type QualityProfileName,
} from '@/stream/qualityProfiles.js';
import { HlsPlaylistCreator } from '@/stream/hls/HlsPlaylistCreator.js';
import type { Result } from '@/types/result.js';
import { TruthyQueryParam } from '@/types/schemas.js';
import type { RouterPluginAsyncCallback } from '@/types/serverType.js';
import type { Maybe } from '@/types/util.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { makeLocalUrl } from '@/util/serverUtil.js';
import fastifyStatic from '@fastify/static';
import type { StreamConnectionDetails } from '@tunarr/types/api';
import { ChannelStreamModeSchema } from '@tunarr/types/schemas';
import dayjs from 'dayjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isArray, isNil, isNumber, isUndefined } from 'lodash-es';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { format } from 'node:util';
import { match } from 'ts-pattern';
import { v4 } from 'uuid';
import z from 'zod/v4';

const deviceForRequest = async (req: FastifyRequest) => {
  const auth = parseBasicAuth(req.headers.authorization);
  return auth
    ? await req.serverCtx.clientDeviceDB.verify(
        auth.user,
        auth.password,
        req.ip,
      )
    : undefined;
};

export const ChannelTsQuerySchema = z.object({
  streamMode: ChannelStreamModeSchema.optional(),
  quality: z.enum(['high', 'low', 'fire']).optional(),
  size: z.enum(['pip', 'full']).optional(),
  token: z.uuid().optional(),
  audioOnly: TruthyQueryParam.optional().default(false),
});

export function concatSessionTypeForQuality(
  mode: z.infer<typeof ChannelStreamModeSchema>,
  quality: 'high' | 'low' | 'fire' | undefined,
  profile?: QualityProfileName,
): ConcatSessionOptions['sessionType'] {
  // Fire keeps its own re-encode; otherwise a reduced profile gets its own
  // transcode instead of re-encoding the full-size one.
  if (mode === 'hls' && quality !== 'fire' && isReducedProfile(profile)) {
    return `hls~${profile}_concat`;
  }
  return quality === 'low' || quality === 'fire'
    ? `${mode}_concat_${quality}`
    : `${mode}_concat`;
}

export const streamApi: RouterPluginAsyncCallback = async (fastify) => {
  const logger = LoggerFactory.child({
    caller: import.meta,
    className: 'StreamApi',
  });

  fastify.addHook('onError', (req, _, error, done) => {
    logger.error(
      error,
      '%s %s',
      isArray(req.routeOptions.method)
        ? req.routeOptions.method.join(', ')
        : req.routeOptions.method,
      req.routeOptions.url,
    );
    done();
  });

  await fastify.register(fastifyStatic, {
    // TODO: Is this even necessary anymore?
    root: join(process.cwd(), 'streams'),
    prefix: '/streams/',
    schemaHide: true,
    decorateReply: true,
  });

  fastify.get(
    '/stream/channels/:id',
    {
      schema: {
        tags: ['Streaming'],
        params: z.object({
          id: z.coerce.number().or(z.uuid()),
        }),
        querystring: z.object({
          streamMode: ChannelStreamModeSchema.optional(),
          token: z.uuid().optional(),
          audioOnly: TruthyQueryParam.optional().default(false),
        }),
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannel(req.params.id);
      if (isNil(channel)) {
        return res.status(404).send('Channel not found.');
      }

      const mode = req.query.streamMode ?? channel.streamMode;

      const params = new URLSearchParams();
      params.set('mode', mode);

      switch (mode) {
        case 'hls':
        case 'hls_slower':
        case 'hls_direct':
          return res.redirect(
            `/stream/channels/${channel.uuid}.m3u8?${params.toString()}`,
          );
        case 'mpegts':
          return res.redirect(
            `/stream/channels/${channel.uuid}.ts?${params.toString()}`,
          );
      }
    },
  );

  /**
   * Returns a continuous, direct MPEGTS video stream for the given channel
   */
  fastify.get(
    '/stream/channels/:id.ts',
    {
      schema: {
        tags: ['Streaming'],
        description:
          'Returns a continuous, direct MPEGTS video stream for the given channel',
        params: z.object({
          id: z.coerce.number().or(z.uuid()),
        }),
        querystring: ChannelTsQuerySchema,
      },
      onError(_req, _res, err, done) {
        console.error(err);
        done();
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannel(req.params.id);
      if (isNil(channel)) {
        return res.status(404).send('Channel not found.');
      }

      const lineup = await req.serverCtx.channelDB.loadLineup(channel.uuid);

      const mode = req.query.streamMode ?? channel.streamMode;
      const token = req.query.token ?? v4();

      const device = await deviceForRequest(req);
      const profile = resolveProfile({ device, size: req.query.size });

      const sessionResult =
        await req.serverCtx.sessionManager.getOrCreateConcatSession(
          channel.uuid,
          token,
          {
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          },
          {
            audioOnly: req.query.audioOnly,
            sessionType: concatSessionTypeForQuality(
              mode,
              req.query.quality,
              profile,
            ),
          },
        );

      if (sessionResult.isFailure()) {
        return match(sessionResult.error.type)
          .with('channel_not_found', () =>
            res.status(404).send('Channel not found.'),
          )
          .with('generic_error', () =>
            res.status(500).send('Unable to start session'),
          )
          .with('transcode_config_not_found', () =>
            res.status(404).send('Transcode config not found'),
          )
          .with(undefined, () =>
            res
              .status(500)
              .send(`Unknown error occurred. Check logs for details`),
          )
          .exhaustive();
      }

      const session = sessionResult.get();

      if (lineup.onDemandConfig) {
        await req.serverCtx.onDemandChannelService.resumeChannel(channel.uuid);
      }

      // We have to create an intermediate stream between the raw one
      // and the response so that nothing messes up the backing raw stream
      // when the request closes (i.e. anything that might happen internal
      // in fastify on the send).
      // TODO: We could probably record periodic heartbeats by listening
      // to the data event on this piped stream. Just debounce them!
      const piped = new PassThrough({ allowHalfOpen: false });
      // Not pipe(): that pauses the raw stream for every viewer while the
      // slowest one drains. A viewer that falls ~8 MB behind is dropped.
      fanOut(session.rawStream, piped);

      piped.on('close', () => {
        logger.debug(
          { token, ip: req.ip, channel: req.params.id },
          'Concat request closed.',
        );

        session.removeConnection(token);
      });

      const onEnd = () => {
        logger.debug(
          { token, ip: req.ip, channel: req.params.id },
          'Session end - closing response stream',
        );
        piped.end();
      };
      const onCleanup = () => {
        logger.debug(
          { token, ip: req.ip, channel: req.params.id },
          'Session cleanup - closing response stream',
        );
        piped.end();
      };
      // Close the request on error.
      const onError = (error: unknown) => {
        logger.error(
          { token, ip: req.ip, channel: req.params.id, error },
          'Session error - closing response stream',
        );
        piped.end();
      };
      session.on('end', onEnd);
      session.on('cleanup', onCleanup);
      session.on('error', onError);
      // Don't leave a listener (and the closed stream it holds) on the
      // session for every request it ever served.
      piped.on('close', () => {
        session.off('end', onEnd);
        session.off('cleanup', onCleanup);
        session.off('error', onError);
      });

      return res.header('Content-Type', 'video/mp2t').send(piped);
    },
  );

  /**
   * Initiates an audio only stream for the given channel
   */
  fastify.get(
    '/stream/channels/:id/radio.ts',
    {
      schema: {
        hide: true,
        params: z.object({
          id: z.coerce.number().or(z.string().uuid()),
        }),
        querystring: z.object({
          streamMode: ChannelStreamModeSchema.optional(),
          token: z.string().uuid().optional(),
        }),
      },
    },
    async (req, res) => {
      return res.redirect(
        makeLocalUrl(`/stream/channels/${req.params.id}.ts`, {
          audioOnly: true,
          ...req.query,
        }),
      );
    },
  );

  fastify.get(
    '/stream/channels/:id/:sessionType/:file',
    {
      schema: {
        hide: true,
        params: z.object({
          sessionType: ChannelStreamModeSchema.refine(
            (typ) => typ !== 'mpegts',
          ).or(z.enum(['hls~480p', 'hls~720p'])),
          id: z.string().uuid(),
          file: z.string(),
        }),
      },
      config: {
        disableRequestLogging: true,
      },
    },
    async (req, res) => {
      let session: Maybe<BaseHlsSession>;
      switch (req.params.sessionType) {
        case 'hls':
          session = req.serverCtx.sessionManager.getHlsSession(req.params.id);
          break;
        case 'hls~480p':
        case 'hls~720p':
          session = req.serverCtx.sessionManager.getHlsSession(
            req.params.id,
            req.params.sessionType.slice(4) as QualityProfileName,
          );
          break;
        case 'hls_slower':
          session = req.serverCtx.sessionManager.getHlsSlowerSession(
            req.params.id,
          );
          break;
        default:
          return res
            .status(400)
            .send(
              `Invalid sesssion type for fragment file serving: ${req.params.sessionType}`,
            );
      }

      if (isUndefined(session)) {
        return res.status(404).send('No session found');
      }

      session.recordHeartbeat(req.ip);

      return res.sendFile(req.params.file, session.workingDirectory);
    },
  );

  fastify.route({
    url: '/stream/channels/:id.m3u8',
    method: ['HEAD', 'GET'],
    schema: {
      tags: ['Streaming'],
      description:
        'Returns an m3u8 playlist for the given channel, for use in HLS',
      params: z.object({
        id: z.uuid().or(z.coerce.number()),
      }),
      querystring: z.object({
        mode: ChannelStreamModeSchema.optional(),
        profile: z.enum(QualityProfileNames).optional(),
      }),
    },
    handler: async (req, res) => {
      const connectionDetails: StreamConnectionDetails = {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      };

      let channel: Maybe<Channel>;
      let channelId: string;
      if (isNumber(req.params.id)) {
        channel = await req.serverCtx.channelDB.getChannel(req.params.id);
        if (isNil(channel)) {
          return res.status(404).send('Channel not found.');
        }
        channelId = channel.uuid;
      } else {
        channelId = req.params.id;
      }

      let mode = req.query.mode;
      if (isUndefined(mode)) {
        channel ??= await req.serverCtx.channelDB.getChannel(req.params.id);
        if (isNil(channel)) {
          return res.status(404).send('Channel not found.');
        }
        mode = channel.streamMode;
      }

      let sessionResult: Result<FastifyReply>;
      switch (mode) {
        case 'hls':
          sessionResult = await req.serverCtx.sessionManager
            .getOrCreateHlsSession(channelId, req.ip, connectionDetails, {
              profile: req.query.profile,
            })
            .then((result) =>
              result.mapAsync(async (session) => {
                session.recordHeartbeat(req.ip);
                const playlistResult = await session.trimPlaylist(
                  dayjs().subtract(30, 'seconds'),
                );

                if (playlistResult.isFailure()) {
                  logger.error(playlistResult.error);
                  throw new Error(
                    'Error retrieving HLS playlist for playback',
                    { cause: playlistResult.error },
                  );
                }

                const playlist = playlistResult.get();

                if (!playlist) {
                  const fmtError = format(
                    'No playlist found for channel %s at path %s. This could mean the stream is not ready.',
                    channelId,
                    session.m3uPlaylistPath,
                  );
                  logger.error(fmtError);
                  throw new Error(fmtError);
                }

                return res
                  .type('application/vnd.apple.mpegurl')
                  .send(playlist.playlist);
              }),
            );

          break;
        case 'hls_slower':
          sessionResult = await req.serverCtx.sessionManager
            .getOrCreateHlsSlowerSession(
              channelId,
              req.ip,
              connectionDetails,
              {},
            )
            .then((result) =>
              result.mapAsync(async (session) => {
                session.recordHeartbeat(req.ip);
                const playlist = await fs.readFile(session.streamPath);
                return res.type('application/vnd.apple.mpegurl').send(playlist);
              }),
            );
          break;
        case 'hls_direct': {
          const ffmpegSettings = req.serverCtx.settings.ffmpegSettings();
          const playlist = await new HlsPlaylistCreator(
            req.serverCtx.streamProgramCalculator,
          ).createPlaylist(channelId, dayjs(), {
            protocol: req.protocol,
            host: req.host,
            channelIdOrNumber: channelId,
            streamMode: mode,
            outputFormat: ffmpegSettings.hlsDirectOutputFormat,
          });
          return res.type('application/vnd.apple.mpegurl').send(playlist);
        }
        case 'mpegts':
          return res.status(400).send();
      }

      if (sessionResult.isFailure()) {
        logger.error(sessionResult.error);
      }

      return sessionResult.getOrElse(() => {
        return res.status(500).send('Error starting or retrieving session');
      });
    },
  });
};
