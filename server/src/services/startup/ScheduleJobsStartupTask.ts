import { inject, injectable, interfaces } from 'inversify';
import { filter, flatten, forEach, values } from 'lodash-es';
import { container } from '../../container.ts';
import { ISettingsDB } from '../../db/interfaces/ISettingsDB.ts';
import { CleanupSessionsTask } from '../../tasks/CleanupSessionsTask.ts';
import { OnDemandChannelStateTask } from '../../tasks/OnDemandChannelStateTask.ts';
import { RefreshMediaSourceLibraryTask } from '../../tasks/RefreshMediaSourceLibraryTask.ts';
import { ScanLibrariesTask } from '../../tasks/ScanLibrariesTask.ts';
import { ScheduledTask } from '../../tasks/ScheduledTask.ts';
import { AiScheduleTask } from '../../tasks/AiScheduleTask.ts';
import { ScheduleDynamicChannelsTask } from '../../tasks/ScheduleDynamicChannelsTask.ts';
import { SubtitleExtractorTask } from '../../tasks/SubtitleExtractorTask.ts';
import { UpdateXmlTvTask } from '../../tasks/UpdateXmlTvTask.ts';
import { autoFactoryKey, KEYS } from '../../types/inject.ts';
import { Logger, LoggerFactory } from '../../util/logging/LoggerFactory.ts';
import {
  GlobalScheduler,
  hoursCrontab,
  minutesCrontab,
  scheduleBackupJobs,
} from '../Scheduler.ts';
import { ChannelLineupMigratorStartupTask } from './ChannelLineupMigratorStartupTask.ts';
import { SimpleStartupTask } from './IStartupTask.ts';

@injectable()
export class ScheduleJobsStartupTask extends SimpleStartupTask {
  id = ScheduleJobsStartupTask.name;
  dependencies = [ChannelLineupMigratorStartupTask.name];

  constructor(
    @inject(KEYS.SettingsDB) private settingsDB: ISettingsDB,
    @inject(KEYS.Logger) private logger: Logger,
  ) {
    super();
  }

  getPromise(): Promise<void> {
    const xmlTvSettings = this.settingsDB.xmlTvSettings();

    GlobalScheduler.scheduleTask(
      UpdateXmlTvTask.ID,
      new ScheduledTask(
        UpdateXmlTvTask,
        // :30 is clear of the other hourly jobs (7, 22, 37, 45, 52) and of the
        // media czar's lineup rebuilds at :00 on the mini.
        hoursCrontab(xmlTvSettings.refreshHours, 30),
        container.get<interfaces.AutoFactory<UpdateXmlTvTask>>(
          KEYS.UpdateXmlTvTaskFactory,
        ),
        {},
      ),
    );

    GlobalScheduler.scheduleTask(
      CleanupSessionsTask.ID,
      new ScheduledTask(
        CleanupSessionsTask,
        // Every 10 s: a dead wrapper's straggling loopback connection goes
        // stale 30 s after its last heartbeat, and the transcode it pinned
        // should be gone within the minute.
        '*/10 * * * * *',
        container.get<interfaces.AutoFactory<CleanupSessionsTask>>(
          CleanupSessionsTask.KEY,
        ),
        undefined,
      ),
    );

    GlobalScheduler.scheduleTask(
      OnDemandChannelStateTask.ID,
      new ScheduledTask(
        OnDemandChannelStateTask,
        minutesCrontab(1),
        container.get<interfaces.AutoFactory<OnDemandChannelStateTask>>(
          OnDemandChannelStateTask.KEY,
        ),
        undefined,
        { runAtStartup: true },
      ),
    );

    GlobalScheduler.scheduleTask(
      ScheduleDynamicChannelsTask.ID,
      new ScheduledTask(
        ScheduleDynamicChannelsTask,
        // Temporary
        hoursCrontab(1, 7),
        container.get<interfaces.AutoFactory<ScheduleDynamicChannelsTask>>(
          ScheduleDynamicChannelsTask.KEY,
        ),
        undefined,
        {
          runAtStartup: true,
          runOnSchedule: true,
        },
      ),
    );

    GlobalScheduler.scheduleTask(
      SubtitleExtractorTask.ID,
      new ScheduledTask(
        SubtitleExtractorTask,
        hoursCrontab(1, 22),
        container.get<interfaces.AutoFactory<SubtitleExtractorTask>>(
          autoFactoryKey(SubtitleExtractorTask),
        ),
        {},
        {
          runAtStartup: true,
        },
      ),
    );

    GlobalScheduler.scheduleTask(
      RefreshMediaSourceLibraryTask.ID,
      new ScheduledTask(
        RefreshMediaSourceLibraryTask,
        // Once a day at 11:37 UTC (small hours in California): the library
        // list rarely changes, and an hourly run froze every stream for up to
        // 11 s on a long-running process (craigotv-audio, 2026-11-09).
        '0 37 11 * * *',
        () =>
          container.get<RefreshMediaSourceLibraryTask>(
            RefreshMediaSourceLibraryTask,
          ),
        undefined,
      ),
    );

    GlobalScheduler.scheduleTask(
      AiScheduleTask.ID,
      new ScheduledTask(
        AiScheduleTask,
        // Every 6 h: a channel is only refilled after 4 h anyway, and each
        // run builds the library context on the main thread.
        hoursCrontab(6, 52),
        container.get<interfaces.AutoFactory<AiScheduleTask>>(
          AiScheduleTask.KEY,
        ),
        undefined,
      ),
    );

    GlobalScheduler.scheduleTask(
      ScanLibrariesTask.ID,
      new ScheduledTask(
        ScanLibrariesTask,
        hoursCrontab(
          this.settingsDB.globalMediaSourceSettings().rescanIntervalHours,
          45,
        ),
        container.get<interfaces.AutoFactory<ScanLibrariesTask>>(
          ScanLibrariesTask.KEY,
        ),
        undefined,
      ),
    );

    scheduleBackupJobs(this.settingsDB.backup);

    forEach(
      filter(
        flatten(values(GlobalScheduler.scheduledJobsById)),
        (job) => job.runAtStartup,
      ),
      (job) => {
        this.logger.debug('Running startup task %s', job.name);
        job
          .runNow(true)
          .catch((e) =>
            LoggerFactory.root.error(
              e,
              'Error running job %s at startup',
              job.name,
            ),
          );
      },
    );

    return Promise.resolve();
  }
}
