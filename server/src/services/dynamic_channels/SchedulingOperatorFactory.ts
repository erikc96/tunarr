import type { SchedulingOperation } from '@tunarr/types/api';
import type { BumperDB } from '../bumpers/BumperDB.ts';
import { InsertBumpersOperator } from './InsertBumpersOperator.ts';
import { PadProgramsSchedulingOperator } from './PadProgramsSchedulingOperator.ts';
import { RandomSortOperator } from './RandomSortOperator.ts';
import { ReleaseDateSortOperator } from './ReleaseDateSortOperator.ts';
import type { SchedulingOperator } from './SchedulingOperator.ts';

export interface SchedulingOperatorDeps {
  bumperDB?: BumperDB;
}

export class SchedulingOperatorFactory {
  private constructor() {}

  static create(
    config: SchedulingOperation,
    deps?: SchedulingOperatorDeps,
  ): SchedulingOperator<SchedulingOperation> | null {
    switch (config.id) {
      case 'add_padding':
        return new PadProgramsSchedulingOperator(config);
      case 'random_sort':
        return new RandomSortOperator(config);
      case 'release_date_sort':
        return new ReleaseDateSortOperator(config);
      case 'scheduled_redirect':
        // Not implemented
        return null;
      case 'insert_bumpers':
        if (!deps?.bumperDB) {
          return null;
        }
        return new InsertBumpersOperator(config, deps.bumperDB);
    }
  }
}
