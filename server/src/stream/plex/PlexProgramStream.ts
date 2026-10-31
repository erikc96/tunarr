import { isPlexBackedLineupItem } from '@/db/derived_types/StreamLineup.js';
import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { MediaSourceDB } from '@/db/mediaSourceDB.js';
import { MediaSourceType } from '@/db/schema/base.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import type { OutputFormat } from '@/ffmpeg/builder/constants.js';
import type { CacheImageService } from '@/services/cacheImageService.js';
import type { PlayerContext } from '@/stream/PlayerStreamContext.js';
import { ProgramStream } from '@/stream/ProgramStream.js';
import type {
  UpdatePlexPlayStatusScheduledTask,
  UpdatePlexPlayStatusScheduledTaskFactory,
} from '@/tasks/plex/UpdatePlexPlayStatusTask.js';
import { Result } from '@/types/result.js';
import type { Maybe } from '@/types/util.js';
import { ifDefined } from '@/util/index.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import dayjs from 'dayjs';
import type { interfaces } from 'inversify';
import { isNil, isUndefined } from 'lodash-es';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 } from 'uuid';
import type { FFmpegFactory } from '../../ffmpeg/FFmpegModule.js';
import type { StreamOptions } from '../../ffmpeg/ffmpegBase.ts';
import { GlobalScheduler } from '../../services/Scheduler.ts';
import { buildBumperConcat } from '../bumperConcatBuilder.ts';
import { LocalConcatStreamSource } from '../types.ts';
import type { PlexStreamDetails } from './PlexStreamDetails.js';

export class PlexProgramStream extends ProgramStream {
  protected logger = LoggerFactory.child({
    caller: import.meta,
    className: PlexProgramStream.name,
  });

  private killed = false;
  private updatePlexStatusTask: Maybe<UpdatePlexPlayStatusScheduledTask>;

  constructor(
    settingsDB: ISettingsDB,
    private mediaSourceDB: MediaSourceDB,
    private plexStreamDetailsFactory: interfaces.AutoFactory<PlexStreamDetails>,
    cacheImageService: CacheImageService,
    ffmpegFactory: FFmpegFactory,
    private plexPlayStatusUpdateTaskFactory: UpdatePlexPlayStatusScheduledTaskFactory,
    context: PlayerContext,
    outputFormat: OutputFormat,
  ) {
    super(context, outputFormat, settingsDB, cacheImageService, ffmpegFactory);
  }

  protected shutdownInternal() {
    this.killed = true;
    ifDefined(this.updatePlexStatusTask, (task) => {
      task.stop();
    });
  }

  protected async setupInternal(
    opts?: Partial<StreamOptions>,
  ): Promise<Result<FfmpegTranscodeSession>> {
    const lineupItem = this.context.lineupItem;
    if (!isPlexBackedLineupItem(lineupItem)) {
      return Result.forError(
        new Error(
          'Lineup item is not backed by Plex: ' + JSON.stringify(lineupItem),
        ),
      );
    }

    const server = await this.mediaSourceDB.findByType(
      MediaSourceType.Plex,
      lineupItem.program.mediaSourceId,
    );

    if (isNil(server)) {
      return Result.forError(
        new Error(
          `Unable to find server "${lineupItem.program.mediaSourceId}" specified by program.`,
        ),
      );
    }

    if (server.uri.endsWith('/')) {
      server.uri = server.uri.slice(0, server.uri.length - 1);
    }

    const plexSettings = this.settingsDB.plexSettings();
    const plexStreamDetails = this.plexStreamDetailsFactory();

    const watermark = await this.getWatermark();
    const ffmpeg = this.ffmpegFactory(
      this.context.transcodeConfig,
      this.context.sourceChannel,
      this.context.streamMode,
    );

    const streamResult = await plexStreamDetails.getStream({
      server,
      lineupItem: lineupItem.program,
    });
    if (streamResult.isFailure()) {
      return streamResult.recast();
    }

    const stream = streamResult.get();

    if (this.killed) {
      this.logger.warn('Plex stream was killed already, returning');
      return Result.forError(new Error('Plex stream was killed already'));
    }

    const streamStats = stream.streamDetails;
    if (streamStats) {
      streamStats.duration = dayjs.duration(lineupItem.streamDuration);
    }

    const start = dayjs.duration(lineupItem.startOffset ?? 0);

    // Build a bumper concat when within-program or between-program bumpers are
    // configured and the file is accessible locally (type === 'file').
    let effectiveSource = stream.streamSource;
    let concatTmpDir: string | undefined;

    if (
      lineupItem.type === 'program' &&
      (lineupItem.prependBumper || lineupItem.withinBumpers) &&
      stream.streamSource.type === 'file'
    ) {
      try {
        const concatContent = buildBumperConcat(
          stream.streamSource.path,
          lineupItem.duration,
          lineupItem.startOffset ?? 0,
          lineupItem.streamDuration,
          {
            prependBumper: lineupItem.prependBumper,
            withinBumpers: lineupItem.withinBumpers,
          },
        );
        concatTmpDir = await mkdtemp(join(tmpdir(), 'tunarr-bumpers-'));
        const concatPath = join(concatTmpDir, 'concat.txt');
        await writeFile(concatPath, concatContent, 'utf8');
        effectiveSource = new LocalConcatStreamSource(concatPath);
      } catch (err) {
        this.logger.warn(
          { err },
          'Failed to build bumper concat for Plex stream, falling back to regular stream',
        );
      }
    }

    const transcodeSession = await ffmpeg.createStreamSession({
      stream: {
        source: effectiveSource,
        // A bumper concat has no stable subtitle stream index: the first
        // entry may be a bumper, so burning in [0:N] fails the whole filtergraph.
        details:
          effectiveSource instanceof LocalConcatStreamSource
            ? { ...stream.streamDetails, subtitleDetails: undefined }
            : stream.streamDetails,
      },
      options: {
        startTime:
          effectiveSource instanceof LocalConcatStreamSource
            ? dayjs.duration(0)
            : start,
        duration: dayjs.duration(lineupItem.streamDuration),
        watermark,
        realtime: this.context.realtime,
        outputFormat: this.outputFormat,
        streamMode: this.context.streamMode,
        ...(opts ?? {}),
      },
      lineupItem,
    });

    if (isUndefined(transcodeSession)) {
      if (concatTmpDir) {
        void rm(concatTmpDir, { recursive: true, force: true });
      }
      return Result.forError(new Error('Unable to create ffmpeg process'));
    }

    if (concatTmpDir) {
      transcodeSession.process.on('exit', () => {
        void rm(concatTmpDir!, { recursive: true, force: true });
      });
    }

    if (plexSettings.updatePlayStatus) {
      this.updatePlexStatusTask = this.plexPlayStatusUpdateTaskFactory(
        server,
        {
          channelNumber: this.context.sourceChannel.number,
          duration: lineupItem.duration,
          ratingKey: lineupItem.program.externalKey,
          startTime: lineupItem.startOffset ?? 0,
        },
        v4(),
      );

      GlobalScheduler.scheduleTask(
        this.updatePlexStatusTask.id,
        this.updatePlexStatusTask,
      );
    }

    return Result.success(transcodeSession);
  }
}
