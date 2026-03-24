import { ContainerModule } from 'inversify';
import { BumperDB } from './BumperDB.js';
import { BumperScanner } from './BumperScanner.js';

export const BumperModule = new ContainerModule((bind) => {
  bind(BumperDB).toSelf().inSingletonScope();
  bind(BumperScanner).toSelf();
});
