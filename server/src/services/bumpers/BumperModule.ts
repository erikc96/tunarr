import { ContainerModule } from 'inversify';
import { BumperDB } from './BumperDB.js';
import { BumperScanner } from './BumperScanner.js';
import { SilenceAnalyzer } from './SilenceAnalyzer.js';
import { SilenceCache } from './SilenceCache.js';

export const BumperModule = new ContainerModule((bind) => {
  bind(BumperDB).toSelf().inSingletonScope();
  bind(BumperScanner).toSelf();
  bind(SilenceCache).toSelf().inSingletonScope();
  bind(SilenceAnalyzer).toSelf().inSingletonScope();
});
