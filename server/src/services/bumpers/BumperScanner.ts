import type { DrizzleDBAccess } from '@/db/schema/index.js';
import { MediaSource } from '@/db/schema/MediaSource.js';
import type { NewProgramMediaStream } from '@/db/schema/ProgramMediaStream.js';
import type { NewProgramVersion } from '@/db/schema/derivedTypes.js';
import { IProgramDB } from '@/db/interfaces/IProgramDB.js';
import type { NewProgramMediaFile } from '@/db/schema/ProgramMediaFile.js';
import type { NewProgramDao } from '@/db/schema/Program.js';
import { ProgramType } from '@/db/schema/Program.js';
import { FfprobeStreamDetails } from '@/stream/FfprobeStreamDetails.js';
import { KEYS } from '@/types/inject.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import type { BumperFile, BumperPack } from '@tunarr/types/schemas';
import { eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import type { Dirent } from 'node:fs';
import path, { extname } from 'node:path';
import { readdir } from 'node:fs/promises';
import { v4 } from 'uuid';
import dayjs from 'dayjs';
import type { MediaSourceId, MediaSourceName } from '@/db/schema/base.js';
import { tag } from '@tunarr/types';
import { BumperDB } from './BumperDB.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'BumperScanner',
});

const SUPPORTED_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.ts', '.m4v', '.wmv', '.flv', '.webm',
]);

export const BUMPER_SOURCE_PREFIX = 'tunarr-bumpers-';
// Local media sources must carry a mediaType or the API can't serialize them.
export const BUMPER_SOURCE_MEDIA_TYPE = 'other_videos';

/**
 * Bumper packs are backed by an internal local media source with no
 * libraries. It isn't user-manageable, so the media source API hides it.
 */
export function isBumperMediaSource(source: {
  type: string;
  name: string;
}): boolean {
  return (
    source.type === 'local' && source.name.startsWith(BUMPER_SOURCE_PREFIX)
  );
}

export interface CreateBumperPackOptions {
  name: string;
  directory: string;
}

@injectable()
export class BumperScanner {
  constructor(
    @inject(KEYS.DrizzleDB) private drizzle: DrizzleDBAccess,
    @inject(KEYS.ProgramDB) private programDB: IProgramDB,
    @inject(FfprobeStreamDetails) private ffprobe: FfprobeStreamDetails,
    @inject(BumperDB) private bumperDB: BumperDB,
  ) {}

  async createPack(opts: CreateBumperPackOptions): Promise<BumperPack> {
    const packId = v4();
    const mediaSourceUuid = await this.upsertMediaSource(packId, opts.name);
    const files = await this.scanDirectory(
      opts.directory,
      packId,
      mediaSourceUuid,
      opts.name,
    );
    const now = new Date().toISOString();
    const pack: BumperPack = {
      id: packId,
      name: opts.name,
      directory: opts.directory,
      mediaSourceUuid,
      files,
      createdAt: now,
      updatedAt: now,
    };
    await this.bumperDB.savePack(pack);
    return pack;
  }

  async rescanPack(packId: string): Promise<BumperPack> {
    const existing = await this.bumperDB.getPackById(packId);
    if (!existing) {
      throw new Error(`Bumper pack ${packId} not found`);
    }
    const files = await this.scanDirectory(
      existing.directory,
      packId,
      existing.mediaSourceUuid,
      existing.name,
    );
    const updated: BumperPack = {
      ...existing,
      files,
      updatedAt: new Date().toISOString(),
    };
    await this.bumperDB.savePack(updated);
    return updated;
  }

  private async upsertMediaSource(
    packId: string,
    packName: string,
  ): Promise<string> {
    const sourceName = `${BUMPER_SOURCE_PREFIX}${packId}` as MediaSourceName;
    const now = +dayjs();

    const existing = await this.drizzle
      .select({ uuid: MediaSource.uuid })
      .from(MediaSource)
      .where(eq(MediaSource.name, sourceName))
      .limit(1);

    if (existing.length > 0) {
      return existing[0]!.uuid;
    }

    const count = await this.drizzle
      .select({ uuid: MediaSource.uuid })
      .from(MediaSource)
      .then((rows) => rows.length);

    const uuid = tag<MediaSourceId>(v4());

    await this.drizzle.insert(MediaSource).values({
      uuid,
      name: sourceName,
      type: 'local',
      mediaType: BUMPER_SOURCE_MEDIA_TYPE,
      uri: '',
      accessToken: '',
      index: count,
      createdAt: now,
      updatedAt: now,
    });

    logger.info('Created bumper media source %s for pack "%s"', uuid, packName);
    return uuid;
  }

  private async scanDirectory(
    directory: string,
    packId: string,
    mediaSourceUuid: string,
    packName: string,
  ): Promise<BumperFile[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (e) {
      throw new Error(`Cannot read bumper directory "${directory}": ${e}`);
    }

    const videoFiles = entries.filter(
      (e) =>
        e.isFile() &&
        SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()) &&
        !e.name.startsWith('._'),
    );

    if (videoFiles.length === 0) {
      logger.warn('No video files found in bumper directory %s', directory);
      return [];
    }

    const results: BumperFile[] = [];
    for (const entry of videoFiles) {
      const fullPath = path.join(directory, entry.name);
      const file = await this.scanFile(
        fullPath,
        entry.name,
        packId,
        mediaSourceUuid,
        packName,
      );
      if (file) {
        results.push(file);
      }
    }
    return results;
  }

  private async scanFile(
    fullPath: string,
    filename: string,
    packId: string,
    mediaSourceUuid: string,
    packName: string,
  ): Promise<BumperFile | null> {
    logger.debug('Probing bumper file %s', fullPath);
    const probeResult = await this.ffprobe.getStream({ path: fullPath });
    if (probeResult.isFailure()) {
      logger.warn(probeResult.error, 'Failed to probe bumper file %s', fullPath);
      return null;
    }

    const { streamDetails } = probeResult.get();
    const video = streamDetails.videoDetails?.[0];
    const durationMs = streamDetails.duration.asMilliseconds();

    if (!durationMs || durationMs <= 0) {
      logger.warn('Could not determine duration for bumper file %s', fullPath);
      return null;
    }

    const programId = v4();
    const versionId = v4();
    const now = +dayjs();
    // Use the file path as the externalKey (unique per media source)
    const externalKey = fullPath;

    const now_ms = now;

    const mediaStreams: NewProgramMediaStream[] = [];

    for (const vs of streamDetails.videoDetails ?? []) {
      mediaStreams.push({
        uuid: v4(),
        programVersionId: versionId,
        streamKind: 'video',
        codec: vs.codec ?? 'unknown',
        index: vs.streamIndex ?? 0,
        profile: vs.profile ?? null,
        bitsPerSample: vs.bitDepth ?? null,
        channels: null,
        default: 1,
        language: null,
        pixelFormat: vs.pixelFormat ?? null,
        title: null,
      });
    }

    for (const as_ of streamDetails.audioDetails ?? []) {
      mediaStreams.push({
        uuid: v4(),
        programVersionId: versionId,
        streamKind: 'audio',
        codec: as_.codec ?? 'unknown',
        index: as_.index ?? 0,
        profile: as_.profile ?? null,
        bitsPerSample: null,
        channels: as_.channels ?? null,
        default: 1,
        language: as_.languageCodeISO6392 ?? null,
        pixelFormat: null,
        title: as_.title ?? null,
      });
    }

    const mediaFile: NewProgramMediaFile = {
      uuid: v4(),
      path: fullPath,
      programVersionId: versionId,
    };

    const version: NewProgramVersion = {
      uuid: versionId,
      programId,
      createdAt: now_ms,
      updatedAt: now_ms,
      duration: Math.round(durationMs),
      width: video?.width ?? 1920,
      height: video?.height ?? 1080,
      displayAspectRatio: video?.displayAspectRatio ?? '16:9',
      sampleAspectRatio: video?.sampleAspectRatio ?? null,
      frameRate: video?.framerate != null ? String(video.framerate) : null,
      scanKind: (video?.scanType ?? 'unknown') as 'progressive' | 'interlaced' | 'unknown',
      mediaStreams,
      mediaFiles: [mediaFile],
    };

    const program: NewProgramDao = {
      uuid: programId,
      title: filename.replace(/\.[^.]+$/, ''),
      type: ProgramType.OtherVideo,
      sourceType: 'local',
      externalKey,
      externalSourceId: tag<MediaSourceName>(packName),
      mediaSourceId: tag<MediaSourceId>(mediaSourceUuid),
      duration: Math.round(durationMs),
      canonicalId: `bumper:${packId}:${externalKey}`,
      state: 'ok',
      createdAt: now_ms,
      updatedAt: now_ms,
    };

    const upserted = await this.programDB.upsertPrograms({
      program,
      externalIds: [],
      versions: [version],
      artwork: [],
      subtitles: [],
      credits: [],
      genres: [],
      studios: [],
      tags: [],
    });

    logger.debug(
      'Upserted bumper program %s (UUID=%s)',
      filename,
      upserted.uuid,
    );

    return {
      filename,
      path: fullPath,
      durationMs: Math.round(durationMs),
      programUuid: upserted.uuid,
    };
  }
}
