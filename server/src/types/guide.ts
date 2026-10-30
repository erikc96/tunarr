import type { ProgramWithRelationsOrm } from '../db/schema/derivedTypes.ts';

export type ProgramGuideItem = {
  type: 'program';
  program: ProgramWithRelationsOrm;
};

export type FlexGuideItem = {
  type: 'flex';
};

export type RedirectGuideItem = {
  type: 'redirect';
  channelId: string;
  channelNumber: number;
  channelName: string;
};

export type MaterializedGuideItem = {
  start: number;
  stop: number;
  isPaused?: boolean;
  timeRemaining?: number;
  durationMs: number;
  title?: string;
  // A bumper-pack program: its own entry, tagged Filler in XMLTV.
  isBumper?: boolean;
  programming: ProgramGuideItem | FlexGuideItem | RedirectGuideItem;
};
