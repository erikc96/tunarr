import { type IChannelDB } from '@/db/interfaces/IChannelDB.js';
import { isContentItem } from '@/db/derived_types/Lineup.js';
import { KEYS } from '@/types/inject.js';
import { type Logger } from '@/util/logging/LoggerFactory.js';
import { inject, injectable } from 'inversify';
import { ChannelGenerator } from '../services/ai/ChannelGenerator.js';
import { AiSettingsDB } from '../services/ai/AiSettingsDB.js';
import { GlobalScheduler } from '../services/Scheduler.js';
import { UpdateXmlTvTask } from './UpdateXmlTvTask.js';
import { SimpleTask, type TaskId } from './Task.js';
import { simpleTaskDef } from './TaskRegistry.ts';
import type { IProgramDB } from '../db/interfaces/IProgramDB.js';

@injectable()
@simpleTaskDef({ hidden: true })
export class AiScheduleTask extends SimpleTask {
  public static KEY = Symbol.for(AiScheduleTask.name);
  public static ID: TaskId = 'ai-schedule-channels';

  public ID = AiScheduleTask.ID;

  constructor(
    @inject(KEYS.ChannelDB) private channelDB: IChannelDB,
    @inject(KEYS.ProgramDB) private programDB: IProgramDB,
    @inject(ChannelGenerator) private generator: ChannelGenerator,
    @inject(AiSettingsDB) private settingsDB: AiSettingsDB,
    @inject(KEYS.Logger) logger: Logger,
  ) {
    super(logger);
  }

  protected async runInternal(): Promise<void> {
    const settings = await this.settingsDB.get();
    if (!settings.apiKey) {
      this.logger.debug('No AI API key configured, skipping AI scheduling');
      return;
    }

    const allChannels = await this.channelDB.getAllChannels();
    const lineupConfigs = await this.channelDB.loadAllLineupConfigs();

    for (const channel of allChannels) {
      const config = lineupConfigs[channel.uuid];
      if (!config) continue;

      const aiConfig = config.lineup.aiConfig;
      if (!aiConfig?.prompt) continue;

      const now = Date.now();
      const hoursSinceLast = aiConfig.lastScheduled
        ? (now - aiConfig.lastScheduled) / (1000 * 60 * 60)
        : Infinity;

      // Only reschedule if it's been at least 4 hours
      if (hoursSinceLast < 4) continue;

      const items = config.lineup.items.filter(isContentItem);

      // Only replenish if lineup is getting short (under 6 hours of content)
      const totalDurationMs = items.reduce((sum, i) => sum + (i.durationMs ?? 0), 0);
      const totalHours = totalDurationMs / (1000 * 60 * 60);

      if (totalHours > 6 && hoursSinceLast < 24) continue;

      this.logger.info(
        `AI scheduling channel "${channel.name}": ${Math.round(totalHours)}h of content, ${items.length} items`,
      );

      try {
        await this.replenishChannel(channel.uuid, channel.name, aiConfig.prompt);

        await this.channelDB.updateLineupConfig(channel.uuid, 'aiConfig', {
          ...aiConfig,
          lastScheduled: now,
        });
      } catch (err) {
        this.logger.error(err, `Failed to AI-schedule channel "${channel.name}"`);
      }
    }
  }

  private async replenishChannel(
    channelId: string,
    channelName: string,
    prompt: string,
  ) {
    const allChannels = await this.channelDB.getAllChannels();
    const existingChannels = allChannels.map((c) => ({
      number: c.number,
      name: c.name,
    }));

    const proposal = await this.generator.generate(prompt, existingChannels);

    if ('error' in proposal) {
      this.logger.warn(`AI generation failed for "${channelName}": ${proposal.error}`);
      return;
    }

    if (proposal.programUuids.length === 0) {
      this.logger.warn(`AI returned no programs for "${channelName}"`);
      return;
    }

    const programs = await this.programDB.getProgramsByIds(proposal.programUuids);
    const durationByUuid = new Map(programs.map((p) => [p.uuid, p.duration]));

    const lineupItems = proposal.programUuids
      .filter((uuid) => durationByUuid.has(uuid))
      .map((uuid) => ({
        type: 'persisted' as const,
        programId: uuid,
        duration: durationByUuid.get(uuid)!,
      }));

    await this.channelDB.updateLineup(channelId, {
      type: 'manual',
      programs: [],
      lineup: lineupItems,
      append: false,
    });

    this.logger.info(
      `AI replenished channel "${channelName}" with ${lineupItems.length} programs`,
    );

    GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
      .runNow(true)
      .catch((err) => this.logger.error(err, 'Error regenerating guide after AI schedule'));
  }
}
