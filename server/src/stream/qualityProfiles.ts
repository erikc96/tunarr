// 1080p is the channel's own transcode config, untouched. The smaller
// profiles get their own HLS transcode at that size (one per channel).
export const QualityProfileNames = ['480p', '720p', '1080p'] as const;
export type QualityProfileName = (typeof QualityProfileNames)[number];
export type ReducedProfileName = Exclude<QualityProfileName, '1080p'>;

type ProfileSpec = {
  resolution: { widthPx: number; heightPx: number };
  videoKbps: number;
  audioKbps: number;
  // Share of the transcode budget one session at this size costs.
  weight: number;
};

export const QUALITY_PROFILES: Record<ReducedProfileName, ProfileSpec> = {
  '480p': {
    resolution: { widthPx: 854, heightPx: 480 },
    videoKbps: 1200,
    audioKbps: 128,
    weight: 0.25,
  },
  '720p': {
    resolution: { widthPx: 1280, heightPx: 720 },
    videoKbps: 3000,
    audioKbps: 160,
    weight: 0.5,
  },
};

export function isQualityProfileName(s: unknown): s is QualityProfileName {
  return (QualityProfileNames as readonly unknown[]).includes(s);
}

export function isReducedProfile(
  p: QualityProfileName | undefined,
): p is ReducedProfileName {
  return p !== undefined && p !== '1080p';
}

/** Weight of one transcode at this profile; undefined/1080p cost 1. */
export function profileWeight(p: QualityProfileName | undefined): number {
  return isReducedProfile(p) ? QUALITY_PROFILES[p].weight : 1;
}

type ProfiledConfig = {
  resolution: { widthPx: number; heightPx: number };
  videoBitRate: number;
  videoBufferSize: number;
  audioBitRate: number;
};

export function applyProfile<T extends ProfiledConfig>(
  config: T,
  p: QualityProfileName | undefined,
): T {
  if (!isReducedProfile(p)) {
    return config;
  }
  const spec = QUALITY_PROFILES[p];
  return {
    ...config,
    resolution: spec.resolution,
    videoBitRate: spec.videoKbps,
    videoBufferSize: spec.videoKbps * 2,
    audioBitRate: spec.audioKbps,
  };
}

export type ProfileRequest = {
  device?: { profile: QualityProfileName };
  size?: 'pip' | 'full';
};

/**
 * Which reduced-size transcode (if any) serves a request. First match wins:
 * a verified device, then the player's ?size=. undefined means the channel's
 * own config (and today's ?quality= handling).
 */
export function resolveProfile(
  req: ProfileRequest,
): QualityProfileName | undefined {
  if (req.device) {
    return req.device.profile;
  }
  if (req.size === 'pip') {
    return '720p';
  }
  if (req.size === 'full') {
    return '1080p';
  }
  return undefined;
}
