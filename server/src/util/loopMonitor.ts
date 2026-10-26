import { monitorEventLoopDelay } from 'node:perf_hooks';

const WindowMs = 30_000;
const histogram = monitorEventLoopDelay({ resolution: 10 });
let previousP99Ms = 0;
let started = false;

/** Start sampling event loop delay in 30 s windows (idempotent). */
export function startLoopMonitor() {
  if (started) return;
  started = true;
  histogram.enable();
  setInterval(() => {
    previousP99Ms = histogram.percentile(99) / 1e6;
    histogram.reset();
  }, WindowMs).unref();
}

/** Worst p99 event loop delay over the current and previous 30 s window. */
export function loopP99Ms() {
  const current = histogram.count > 0 ? histogram.percentile(99) / 1e6 : 0;
  return Math.round(Math.max(current, previousP99Ms) * 10) / 10;
}
