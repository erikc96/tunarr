import { ContainerModule } from 'inversify';
import { ActBreakAnalyzer } from './ActBreakAnalyzer.js';
import { ActBreakCache } from './ActBreakCache.js';

export const ActBreakModule = new ContainerModule((bind) => {
  bind(ActBreakCache).toSelf().inSingletonScope();
  bind(ActBreakAnalyzer).toSelf().inSingletonScope();
});
