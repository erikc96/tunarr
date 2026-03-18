import { ContainerModule } from 'inversify';
import { AiSettingsDB } from './AiSettingsDB.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { ContextBuilder } from './ContextBuilder.js';
import { ChannelGenerator } from './ChannelGenerator.js';
import { ChannelRefresher } from './ChannelRefresher.js';
import { RecommendationEngine } from './RecommendationEngine.js';

export const AiModule = new ContainerModule((bind) => {
  bind(AiSettingsDB).toSelf().inSingletonScope();
  bind(AnthropicAdapter).toSelf().inSingletonScope();
  bind(ContextBuilder).toSelf();
  bind(ChannelGenerator).toSelf();
  bind(ChannelRefresher).toSelf();
  bind(RecommendationEngine).toSelf();
});
