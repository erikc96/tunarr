// Benchmark a full guide rebuild against a copy of a Tunarr data directory and
// report how long it blocks the event loop.
//
//   tsx scripts/bench-guide.ts -d /path/to/copy [--hours 12] [--runs 3]
//
// BENCH_SPLIT=1 also times getProgramsByIds and xmltv.write inside
// writeXmlTv, and the program loop with both stubbed out.
//
// Take the copy with `sqlite3 SRC ".backup DEST"` plus the channel-lineups
// folder and bumpers.json; never copy a live SQLite file.
//
// Never point it at a live data directory: bootstrap runs migrations and the
// rebuild rewrites xmltv.xml.
import 'reflect-metadata';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';

dayjs.extend(duration);

const args = yargs(hideBin(process.argv))
  .option('database', { alias: 'd', type: 'string', demandOption: true })
  .option('hours', { type: 'number', default: 12 })
  .option('runs', { type: 'number', default: 3 })
  .parseSync();

const { setGlobalOptions } = await import('@/globals.js');
setGlobalOptions({
  database: args.database,
  log_level: 'warn',
  verbose: 0,
  hide_banner: true,
} as Parameters<typeof setGlobalOptions>[0]);
const { bootstrapTunarr } = await import('@/bootstrap.js');
await bootstrapTunarr();
const { container } = await import('@/container.js');
const { TVGuideService } = await import('@/services/TvGuideService.js');

const { KEYS } = await import('@/types/inject.js');
const { ChannelDB } = await import('@/db/ChannelDB.js');
const guide = container.get(TVGuideService);
const channelDB = container.get<InstanceType<typeof ChannelDB>>(KEYS.ChannelDB);

// Measures wall time and the longest event-loop stall (gap between ticks of a
// 1 ms interval timer) while `fn` runs.
async function measure(label: string, fn: () => Promise<unknown>) {
  const h = monitorEventLoopDelay({ resolution: 5 });
  let last = performance.now();
  let maxGap = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 1);
  h.enable();
  const start = performance.now();
  await fn();
  const wall = performance.now() - start;
  h.disable();
  clearInterval(tick);
  console.log(
    `${label}: wall=${wall.toFixed(0)}ms maxStall=${maxGap.toFixed(0)}ms ` +
      `loopDelay p99=${(h.percentile(99) / 1e6).toFixed(0)}ms`,
  );
}

const hours = dayjs.duration({ hours: args.hours });
for (let run = 0; run < args.runs; run++) {
  await measure(`run ${run} buildAllChannels`, () =>
    guide.buildAllChannels(hours, true),
  );
  // writeXmlTv alone, on the guide that is now cached.
  await measure(`run ${run} loadAllLineups`, () => channelDB.loadAllLineups());
  await measure(`run ${run} writeXmlTv`, () =>
    guide['withGuideContext'](() => guide['writeXmlTv']()),
  );
}
if (process.env.BENCH_SPLIT) {
  const { ProgramDB } = await import('@/db/ProgramDB.js');
  const programDB = container.get<InstanceType<typeof ProgramDB>>(
    KEYS.ProgramDB,
  );
  const acc = { q: 0, qms: 0, ids: 0, xms: 0 };
  const origQ = programDB.getProgramsByIds.bind(programDB);
  programDB.getProgramsByIds = async (ids, bs) => {
    const t = performance.now();
    const r = await origQ(ids, bs);
    acc.q++;
    acc.ids += ids.length;
    acc.qms += performance.now() - t;
    return r;
  };
  const xmltv = guide['xmltv'];
  const origW = xmltv.write.bind(xmltv);
  xmltv.write = async (...a: Parameters<typeof origW>) => {
    const t = performance.now();
    const r = await origW(...a);
    acc.xms += performance.now() - t;
    return r;
  };
  await measure('split writeXmlTv', () =>
    guide['withGuideContext'](() => guide['writeXmlTv']()),
  );
  const items = Object.values(guide['cachedGuide']).reduce(
    (n, c) => n + c.programs.length,
    0,
  );
  console.log(
    `split: getProgramsByIds calls=${acc.q} ids=${acc.ids} ms=${acc.qms.toFixed(0)} xmltv.write ms=${acc.xms.toFixed(0)} guideItems=${items}`,
  );
  xmltv.write = async () => {};
  programDB.getProgramsByIds = async () => [];
  await measure('split buildAllChannels (no DB, no xml write)', () =>
    guide.buildAllChannels(hours, true),
  );
}
process.exit(0);
