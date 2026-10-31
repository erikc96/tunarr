import dayjs from 'dayjs';
import { head, isUndefined } from 'lodash-es';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SilenceAnalyzer } from '../../services/bumpers/SilenceAnalyzer.ts';
import { isLocalBackedLineupItem } from '../../db/derived_types/StreamLineup.ts';
import { buildBumperConcat } from '../bumperConcatBuilder.ts';
import type { IProgramDB } from '../../db/interfaces/IProgramDB.ts';
import type { ISettingsDB } from '../../db/interfaces/ISettingsDB.ts';
import type { OutputFormat } from '../../ffmpeg/builder/constants.ts';
import type { StreamOptions } from '../../ffmpeg/ffmpegBase.ts';
import type { FFmpegFactory } from '../../ffmpeg/FFmpegModule.ts';
import type { FfmpegTranscodeSession } from '../../ffmpeg/FfmpegTrancodeSession.ts';
import type { CacheImageService } from '../../services/cacheImageService.ts';
import { Result } from '../../types/result.ts';
import { LocalConcatStreamSource } from '../types.ts';
import type { PlayerContext } from '../PlayerStreamContext.ts';
import { ProgramStream } from '../ProgramStream.ts';

import type { interfaces } from 'inversify';
import type { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import { MediaSourceType } from '../../db/schema/base.ts';
import { GenericNotFoundError } from '../../types/errors.ts';
import type { LocalProgramStreamDetails } from './LocalProgramStreamDetails.ts';

export class LocalProgramStream extends ProgramStream {
  private killed = false;

  constructor(
    settingsDB: ISettingsDB,
    cacheImageService: CacheImageService,
    ffmpegFactory: FFmpegFactory,
    private mediaSourceDB: MediaSourceDB,
    private programDB: IProgramDB,
    private streamDetailsFactory: interfaces.AutoFactory<LocalProgramStreamDetails>,
    private silenceAnalyzer: SilenceAnalyzer | undefined,
    context: PlayerContext,
    outputFormat: OutputFormat,
  ) {
    super(context, outputFormat, settingsDB, cacheImageService, ffmpegFactory);
  }

  protected shutdownInternal() {
    super.shutdownInternal();
    this.killed = true;
  }

  protected async setupInternal(
    opts?: Partial<StreamOptions>,
  ): Promise<Result<FfmpegTranscodeSession>> {
    const lineupItem = this.context.lineupItem;
    if (!isLocalBackedLineupItem(lineupItem)) {
      return Result.forError(
        new Error(
          'Lineup item is not a content item: ' + JSON.stringify(lineupItem),
        ),
      );
    }

    const start = dayjs.duration(lineupItem.startOffset ?? 0);

    const ffmpeg = this.ffmpegFactory(
      this.context.transcodeConfig,
      this.context.sourceChannel,
      this.context.streamMode,
    );

    if (this.killed) {
      return Result.forError(new Error('Stream was killed already, returning'));
    }

    const program = await this.programDB.getProgramById(
      lineupItem.program.uuid,
    );

    if (!program) {
      return Result.forError(
        new Error(
          `Could not find program with ID ${lineupItem.program.uuid} when trying to start stream! This is bad!`,
        ),
      );
    }

    const firstVersion = head(program.versions);

    if (!firstVersion) {
      // TODO: Backfill these on the spot
      return Result.forError(
        new Error(
          `Program with ID ${lineupItem.program.uuid} Has no media versions.`,
        ),
      );
    }

    const mediaSource = await this.mediaSourceDB.findByType(
      MediaSourceType.Local,
      lineupItem.program.mediaSourceId,
    );
    if (!mediaSource) {
      return Result.forError(
        new GenericNotFoundError(
          lineupItem.program.mediaSourceId,
          'media_source',
        ),
      );
    }

    const streamResult = await this.streamDetailsFactory().getStream({
      server: mediaSource,
      lineupItem: lineupItem.program,
    });
    if (streamResult.isFailure()) {
      return streamResult.recast();
    }

    const { streamDetails: details, streamSource: source } = streamResult.get();

    // When bumpers are configured, generate a local ffconcat file that
    // prepends between-program bumpers and/or interleaves within-program bumpers.
    let effectiveSource = source;
    let concatTmpDir: string | undefined;

    if (
      lineupItem.type === 'program' &&
      (lineupItem.prependBumper || lineupItem.withinBumpers) &&
      source.type === 'file'
    ) {
      try {
        const silences =
          this.silenceAnalyzer && lineupItem.withinBumpers
            ? await this.silenceAnalyzer.getSilences(source.path)
            : undefined;

        const concatContent = buildBumperConcat(
          source.path,
          lineupItem.duration,
          lineupItem.startOffset ?? 0,
          lineupItem.streamDuration,
          {
            prependBumper: lineupItem.prependBumper,
            withinBumpers: lineupItem.withinBumpers,
          },
          silences,
        );
        concatTmpDir = await mkdtemp(join(tmpdir(), 'tunarr-bumpers-'));
        const concatPath = join(concatTmpDir, 'concat.txt');
        await writeFile(concatPath, concatContent, 'utf8');
        effectiveSource = new LocalConcatStreamSource(concatPath);
      } catch (err) {
        this.logger.warn(
          { err },
          'Failed to build bumper concat, falling back to regular stream',
        );
      }
    }

    const ffmpegOutStream = await ffmpeg.createStreamSession({
      stream: {
        source: effectiveSource,
        // A bumper concat has no stable subtitle stream index: the first
        // entry may be a bumper, so burning in [0:N] fails the whole filtergraph.
        details:
          effectiveSource instanceof LocalConcatStreamSource
            ? { ...details, subtitleDetails: undefined }
            : details,
      },
      options: {
        // For concat sources the seek is handled inside the concat file;
        // pass zero so ffmpeg doesn't also seek on the input.
        startTime:
          effectiveSource instanceof LocalConcatStreamSource
            ? dayjs.duration(0)
            : start,
        duration: dayjs.duration(lineupItem.streamDuration),
        watermark: await this.getWatermark(),
        realtime: this.context.realtime,
        extraInputHeaders: {},
        outputFormat: this.outputFormat,
        streamMode: this.context.streamMode,
        ...(opts ?? {}),
      },
      lineupItem,
    });

    if (isUndefined(ffmpegOutStream)) {
      if (concatTmpDir) {
        void rm(concatTmpDir, { recursive: true, force: true });
      }
      return Result.forError(new Error('Unable to spawn ffmpeg'));
    }

    if (concatTmpDir) {
      // Delete the temp concat file once ffmpeg exits (it only needs it at startup)
      ffmpegOutStream.process.on('exit', () => {
        void rm(concatTmpDir!, { recursive: true, force: true });
      });
    }

    return Result.success(ffmpegOutStream);
  }
}
