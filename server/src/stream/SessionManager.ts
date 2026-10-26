import { Result } from '@/types/result.js';
import { Maybe } from '@/types/util.js';
import { Logger } from '@/util/logging/LoggerFactory.js';
import { MutexMap } from '@/util/mutexMap.js';
import {
  compact,
  filter,
  initial,
  isEmpty,
  isNil,
  isUndefined,
  maxBy,
  omitBy,
  values,
} from 'lodash-es';
import {
  ChannelNotFoundError,
  GenericError,
  TypedError,
} from '../types/errors.js';
import {
  ConcatSession,
  type ConcatSessionFactory,
  type ConcatSessionOptions,
} from './ConcatSession.js';
import { sessionsToEvict } from './ConnectionTracker.ts';
import { HlsConcatSessionType, Session } from './Session.js';
import {
  HlsSession,
  type HlsSessionProvider,
  type HlsSlowerSessionProvider,
} from './hls/HlsSession.js';
import { HlsSlowerSession } from './hls/HlsSlowerSession.js';

import { type IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import { KEYS } from '@/types/inject.js';
import { ifDefined } from '@/util/index.js';
import { ChannelStreamMode } from '@tunarr/types';
import { StreamConnectionDetails } from '@tunarr/types/api';
import { ChannelConcatStreamMode } from '@tunarr/types/schemas';
import dayjs from 'dayjs';
import { inject, injectable } from 'inversify';
import { Dictionary } from 'ts-essentials';
import { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import { EventService } from '../services/EventService.ts';
import { SessionType } from './Session.js';
import { BaseHlsSessionOptions } from './hls/BaseHlsSession.ts';

export type SessionKey = `${string}_${SessionType}`;

@injectable()
export class SessionManager {
  #sessionLocker = new MutexMap();
  #sessions: Record<SessionKey, Session> = {};
  // Transcode sessions with no viewers, and when they lost their last one.
  #idleSince = new Map<SessionKey, number>();

  constructor(
    @inject(KEYS.Logger) private logger: Logger,
    @inject(KEYS.ChannelDB) private channelDB: IChannelDB,
    @inject(OnDemandChannelService)
    private onDemandChannelService: OnDemandChannelService,
    @inject(KEYS.HlsSession) private hlsSessionFactory: HlsSessionProvider,
    @inject(KEYS.HlsSlowerSession)
    private hlsSlowerSessionFactory: HlsSlowerSessionProvider,
    @inject(KEYS.ConcatSession)
    private concatSessionFactory: ConcatSessionFactory,
    @inject(EventService) private eventService: EventService,
    @inject(KEYS.SettingsDB) private settingsDB: ISettingsDB,
  ) {}

  allSessions(): Record<SessionKey, Session> {
    return this.#sessions;
  }

  allSessionsByChannel(): Record<
    string,
    Partial<Record<SessionType, Session>>
  > {
    const ret: Dictionary<Partial<Dictionary<Session, SessionType>>> = {};
    for (const [key, session] of Object.entries(this.#sessions)) {
      const [channelId, sessionType] = key.split('_', 2);
      if (!ret[channelId!]) {
        ret[channelId!] = {};
      }
      ret[channelId!]![sessionType!] = session;
    }
    return omitBy(ret, isEmpty);
  }

  getHlsSlowerSession(id: string): Maybe<HlsSlowerSession> {
    return this.getSession(id, 'hls_slower') as Maybe<HlsSlowerSession>;
  }

  getHlsSession(id: string): Maybe<HlsSession> {
    return this.getSession(id, 'hls') as Maybe<HlsSession>;
  }

  getConcatSession(id: string): Maybe<ConcatSession> {
    return this.getSession(id, 'mpegts') as Maybe<ConcatSession>;
  }

  getHlsWrapperSession(
    id: string,
    typ: HlsConcatSessionType,
  ): Maybe<ConcatSession> {
    return this.getSession(id, typ) as Maybe<ConcatSession>;
  }

  getAllConcatSessions(id: string): Session[] {
    return compact([
      this.getConcatSession(id),
      this.getHlsWrapperSession(id, 'hls_concat'),
      this.getHlsWrapperSession(id, 'hls_slower_concat'),
    ]);
  }

  getSession(id: string, sessionType: SessionType): Maybe<Session> {
    return this.#sessions[sessionCacheKey(id, sessionType)];
  }

  getAllSessionsForChannel(id: string): Session[] {
    const sessions: Session[] = [];
    for (const key of Object.keys(this.#sessions)) {
      if (key.startsWith(id)) {
        sessions.push(this.#sessions[key as SessionKey]!);
      }
    }
    return sessions;
  }

  async endSession(session: Session): Promise<void>;
  async endSession(
    idOrSession: string | Session,
    maybeSessionType?: SessionType,
  ): Promise<void> {
    let id: string;
    let sessionType: SessionType;
    if (idOrSession instanceof Session) {
      ({ id, sessionType } = idOrSession.keyObj);
    } else {
      if (isUndefined(maybeSessionType)) {
        throw new Error('Must pass session type if ending stream by ID');
      } else {
        id = idOrSession;
        sessionType = maybeSessionType;
      }
    }

    const lock = await this.#sessionLocker.getOrCreateLock(id);
    return await lock.runExclusive(async () => {
      const session = this.getSession(id, sessionType);
      if (isNil(session)) {
        return;
      }
      await session.stop();
      delete this.#sessions[sessionCacheKey(id, sessionType)];
    });
  }

  cleanupStaleSessions() {
    for (const session of Object.values(this.#sessions)) {
      if (session.state === 'starting') {
        continue;
      }
      if (session.isStale() && session.scheduleCleanup()) {
        this.logger.debug(
          this.getLoggerContext(session.id),
          'Scheduled cleanup on session',
        );
      }
    }
  }

  async getOrCreateConcatSession(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    options: ConcatSessionOptions,
  ) {
    const lock = await this.#sessionLocker.getOrCreateLock(channelId);
    await lock.runExclusive(() => {
      const underlyingSessionType = sessionTypeFromConcatType(
        options.sessionType,
      );
      if (isUndefined(this.getSession(channelId, underlyingSessionType))) {
        this.logger.debug(
          'No underlying session of type %s found for existing concat session (channel id = %s). Removing dangling session and recreating',
          underlyingSessionType,
          channelId,
        );
        this.deleteSession(channelId, underlyingSessionType);
      }
    });

    return this.getOrCreateSession(
      channelId,
      token,
      connection,
      options.sessionType,
      (channel) => this.concatSessionFactory(channel, options),
    );
  }

  // TODO Consider using a builder pattern here with generics to control
  // the returned session type
  async getOrCreateHlsSlowerSession(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    options?: Partial<BaseHlsSessionOptions>,
  ) {
    return this.getOrCreateSession(
      channelId,
      token,
      connection,
      'hls_slower',
      (channel) =>
        this.hlsSlowerSessionFactory(channel, {
          initialSegmentCount: 2, // 8 seconds of content
          cleanupDelay: this.lingerMs(),
          transcodeDirectory:
            this.settingsDB.ffmpegSettings().transcodeDirectory,
          ...options,
        }),
    );
  }

  async getOrCreateHlsSession(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    options?: Partial<BaseHlsSessionOptions>,
  ) {
    return this.getOrCreateSession(
      channelId,
      token,
      connection,
      'hls',
      (channel) =>
        this.hlsSessionFactory(channel, {
          initialSegmentCount: 1, // 4 seconds of content: the Fire/low re-encode wrapper starts on this child, so one segment cuts the cold start
          cleanupDelay: this.lingerMs(),
          transcodeDirectory:
            this.settingsDB.ffmpegSettings().transcodeDirectory,
          ...options,
        }),
    );
  }

  private async getOrCreateSession<TSession extends Session>(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    sessionType: SessionType,
    sessionFactory: (channel: ChannelOrmWithTranscodeConfig) => TSession,
  ): Promise<Result<TSession, TypedError>> {
    const lock = await this.#sessionLocker.getOrCreateLock(channelId);
    try {
      const session = await lock.runExclusive(async () => {
        let session = this.getSession(
          channelId,
          sessionType,
        ) as Maybe<TSession>;

        if (isNil(session)) {
          const channel = await this.channelDB.getChannelOrm(channelId);

          if (!channel?.transcodeConfig) {
            throw new ChannelNotFoundError(channelId);
          }

          session = sessionFactory(channel);

          this.addSession(channel.uuid, session.sessionType, session);

          session.on('error', (e) => {
            this.logger.error(
              this.getLoggerContext(session?.id, e),
              'Received error from session. Shutting down',
            );
            session?.stop().catch((e) => {
              this.logger.error(
                this.getLoggerContext(session?.id, e),
                'Error while shutting down session. Things are bad!',
              );
            });
            this.shutdownChildSessions(channelId, sessionType);
            this.eventService.push({
              type: 'stream',
              action: 'error',
              level: 'error',
              details: {
                channelId,
                sessionType,
              },
            });
          });

          session.on('stop', () => {
            this.deleteSession(channelId, sessionType);
            this.shutdownChildSessions(channelId, sessionType);
            this.idleUnderlyingSession(channelId, sessionType);
            if (session) {
              this.pauseChannelIfNecessary(session, connection).catch(() => {});
            }
            this.eventService.push({
              type: 'stream',
              action: 'end',
              level: 'info',
              details: {
                channelId,
                sessionType,
              },
            });
          });

          session.on('cleanup', () => {
            this.deleteSession(channelId, sessionType);
            this.shutdownChildSessions(channelId, sessionType);
            this.idleUnderlyingSession(channelId, sessionType);
          });

          session.on('addConnection', () => {
            this.#idleSince.delete(sessionCacheKey(channelId, sessionType));
          });

          session.on('removeConnection', (_, connection) => {
            this.logger.debug(
              this.getLoggerContext(session?.id),
              'Connection removed for session %s: %O',
              session?.id ?? '',
              connection,
            );
            // Sessions linger after their last viewer leaves, so on-demand
            // channels pause on 'stop' instead of here.
            if (
              session &&
              !session.isConcatSession() &&
              session.numConnections() === 0
            ) {
              this.#idleSince.set(
                sessionCacheKey(channelId, sessionType),
                Date.now(),
              );
              this.evictLingeringSessions();
            }
            this.eventService.push({
              type: 'stream',
              action: 'connection_remove',
              level: 'info',
              details: {
                channelId,
                sessionType,
              },
            });
          });

          if (this.getAllSessionsForChannel(channelId).length > 0) {
            this.resumeChannelIfNecessary(channelId);
          }
        }

        if (!session.started || session.hasError) {
          await session.start();
          this.eventService.push({
            type: 'stream',
            action: 'start',
            level: 'info',
            details: {
              channelId,
              sessionType,
            },
          });
        }

        return session;
      });

      if (session.hasError) {
        throw (
          session.error ??
          new GenericError('Session reported error but had none set.')
        );
      }

      session.addConnection(token, connection);
      this.eventService.push({
        type: 'stream',
        action: 'connection_add',
        level: 'info',
        details: {
          channelId,
          sessionType,
        },
      });

      return Result.success(session);
    } catch (e) {
      return Result.failure(TypedError.fromAny(e));
    }
  }

  private addSession(id: string, sessionType: SessionType, session: Session) {
    this.#sessions[sessionCacheKey(id, sessionType)] = session;
  }

  private deleteSession(id: string, sessionType: SessionType) {
    const key = sessionCacheKey(id, sessionType);
    this.#idleSince.delete(key);
    ifDefined(this.#sessions[key], (session) => {
      session.stop().catch((e) => {
        this.logger.error(
          this.getLoggerContext(id, e),
          'Error shutting down session',
        );
      });
    });
    delete this.#sessions[key];
  }

  // How long a transcode keeps running after its last viewer leaves, so
  // coming back to the channel skips the cold start.
  private lingerMs() {
    return (
      (this.settingsDB.ffmpegSettings().idleSessionLingerSeconds ?? 15) * 1000
    );
  }

  // Stop the longest-idle sessions beyond maxLingeringSessions.
  private evictLingeringSessions() {
    const max = this.settingsDB.ffmpegSettings().maxLingeringSessions ?? 2;
    for (const key of sessionsToEvict(this.#idleSince, max)) {
      const session = this.#sessions[key];
      this.#idleSince.delete(key);
      if (session) {
        this.logger.debug(
          this.getLoggerContext(session.id),
          'Too many lingering sessions (max %d). Stopping %s',
          max,
          key,
        );
        this.deleteSession(session.keyObj.id, session.sessionType);
      }
    }
  }

  private resumeChannelIfNecessary(channelId: string) {
    this.logger.debug('Resuming channel %s at %s', channelId, dayjs().format());
    this.onDemandChannelService.resumeChannel(channelId).catch((e) => {
      this.logger.error(
        this.getLoggerContext(channelId, e),
        'Error resuming on-demand channel %s',
        channelId,
      );
    });
  }

  private async pauseChannelIfNecessary(
    session: Session,
    lastConnection: StreamConnectionDetails,
  ) {
    try {
      const now = +dayjs();
      let sessionToCheck = session;
      let pauseTime = lastConnection.lastHeartbeat ?? now;
      if (session.isConcatSession()) {
        const underlyingType = sessionTypeFromConcatType(session.sessionType);
        const underlyingSession = this.getSession(
          session.keyObj.id,
          underlyingType,
        );
        if (underlyingSession) {
          sessionToCheck = underlyingSession;
          pauseTime =
            maxBy(values(sessionToCheck.connections()), 'lastHeartbeat')
              ?.lastHeartbeat ?? +dayjs();
        }
      }

      if (
        sessionToCheck.sessionType === 'mpegts_concat' ||
        sessionToCheck.sessionType === 'mpegts'
      ) {
        // No heartbeats on a raw stream, just pause at "now"
        pauseTime = now;
      }

      const nonTunarrConnections = filter(
        sessionToCheck.connections(),
        (conn) => !(conn.userAgent?.includes('Tunarr') ?? false),
      ).length;

      // Pause the channel as soon as there are no connections
      // other than internal connections
      if (nonTunarrConnections === 0) {
        this.logger.debug(
          this.getLoggerContext(session.id),
          'Pausing channel %s after disconnect. Pause time = %s',
          session.keyObj.id,
          dayjs(pauseTime).format(),
        );
        await this.onDemandChannelService.pauseChannel(
          session.keyObj.id,
          pauseTime,
        );
      } else {
        this.logger.debug(
          this.getLoggerContext(sessionToCheck.id),
          'Detected %d remaining sessions. Not pausing session.',
          nonTunarrConnections,
        );
      }
    } catch (e) {
      this.logger.error(
        this.getLoggerContext(session.id, e),
        'Error while trying to pause channel %s',
        session.id,
      );
    }
  }

  private shutdownChildSessions(id: string, sessionType: SessionType) {
    for (const childType of concatWrapperTypes(sessionType)) {
      this.getSession(id, childType)
        ?.stop()
        .catch((e) => {
          this.logger.error(e, 'Error shutting down associated concat session');
        });
    }
  }

  // When the last wrapper (concat, _low, _fire) over a transcode stops, the
  // transcode has no viewer left: mark it idle so the linger cap can evict
  // it instead of it running until its own staleness timer fires.
  private idleUnderlyingSession(id: string, sessionType: SessionType) {
    if (!sessionType.includes(ConcatSuffix)) {
      return;
    }
    const underlyingType = sessionTypeFromConcatType(
      sessionType as ConcatSessionOptions['sessionType'],
    ) as SessionType;
    const underlying = this.getSession(id, underlyingType);
    if (
      !underlying ||
      concatWrapperTypes(underlyingType).some((t) => this.getSession(id, t))
    ) {
      return;
    }
    const viewers = filter(
      underlying.connections(),
      (conn) => !(conn.userAgent?.includes('Tunarr') ?? false),
    ).length;
    if (viewers > 0) {
      return;
    }
    this.#idleSince.set(sessionCacheKey(id, underlyingType), Date.now());
    this.evictLingeringSessions();
  }

  private getLoggerContext(sessionId?: string, error?: unknown) {
    return { error, sessionId };
  }
}

function sessionTypeFromConcatType(
  typ: ConcatSessionOptions['sessionType'],
): ChannelStreamMode {
  return initial(typ.replace(/_(low|fire)$/, '').split('_')).join(
    '_',
  ) as ChannelStreamMode;
}

const ConcatSuffix = '_concat';

/** Session types of the wrappers that can sit on top of a transcode type. */
export function concatWrapperTypes(typ: SessionType): SessionType[] {
  const base = `${typ}${ConcatSuffix}` as ChannelConcatStreamMode;
  return [base, `${base}_low`, `${base}_fire`];
}

function sessionCacheKey(id: string, sessionType: SessionType): SessionKey {
  return `${id}_${sessionType}`;
}
