import { readdirSync, readFileSync } from 'fs';

// File-descriptor capacity monitoring.
//
// The production app previously crashed with EMFILE ("too many open files")
// because open FDs (sockets, files, DB connections, browser handles) slowly
// accumulated until they hit the OS limit. The leak is fixed, but a future
// regression would again surface only as a sudden crash with no warning.
// This module samples the live process FD count against the OS limit so the
// trend is visible on the Team page and in the scrape-cycle logs.

export interface FdSample {
  timestamp: string;
  open: number;
  limit: number;
  percent: number;
}

// Default warning threshold (percentage of the limit). Overridable via env so
// it can be tuned in production without a code change.
export const FD_WARN_THRESHOLD = Math.max(
  1,
  Math.min(100, parseInt(process.env.FD_WARN_THRESHOLD || '80', 10) || 80),
);

const MAX_SAMPLES = 60;
const history: FdSample[] = [];

// Count the process's currently open file descriptors. On Linux each open FD
// appears as an entry under /proc/self/fd. Returns -1 when unavailable (e.g.
// non-Linux dev hosts) so callers can detect that the reading is unsupported.
function countOpenFds(): number {
  try {
    // The readdir handle itself is one of the listed entries; that is fine —
    // we report the live count including this transient descriptor.
    return readdirSync('/proc/self/fd').length;
  } catch {
    return -1;
  }
}

// Read the soft FD limit (RLIMIT_NOFILE) from /proc/self/limits. This is the
// ceiling the process actually hits before EMFILE. Returns -1 when unavailable.
function readFdLimit(): number {
  try {
    const limits = readFileSync('/proc/self/limits', 'utf-8');
    for (const line of limits.split('\n')) {
      if (line.startsWith('Max open files')) {
        // Format: "Max open files   <soft>   <hard>   files"
        const parts = line.trim().split(/\s+/);
        const soft = parts[3];
        if (soft === 'unlimited') return -1;
        const n = parseInt(soft, 10);
        return Number.isFinite(n) ? n : -1;
      }
    }
  } catch {
    // fall through
  }
  return -1;
}

// Take a fresh FD sample, push it onto the in-memory ring buffer, and return it.
export function sampleFdUsage(): FdSample {
  const open = countOpenFds();
  const limit = readFdLimit();
  const percent = open >= 0 && limit > 0 ? Math.round((open / limit) * 100) : 0;
  const sample: FdSample = {
    timestamp: new Date().toISOString(),
    open,
    limit,
    percent,
  };
  history.push(sample);
  if (history.length > MAX_SAMPLES) {
    history.shift();
  }
  return sample;
}

// Return the buffered samples (oldest first).
export function getFdHistory(): FdSample[] {
  return [...history];
}

// Take a sample and log a concise one-line summary, elevated to a warning when
// usage crosses the configured threshold. Returns the sample for reuse.
export function logFdSample(): FdSample {
  const sample = sampleFdUsage();
  if (sample.open < 0 || sample.limit < 0) {
    console.log('[FDMonitor] FD usage unavailable (non-Linux host)');
    return sample;
  }
  const line = `[FDMonitor] ${sample.open}/${sample.limit} FDs (${sample.percent}%)`;
  if (sample.percent >= FD_WARN_THRESHOLD) {
    console.warn(`⚠️ ${line} — above ${FD_WARN_THRESHOLD}% threshold`);
  } else {
    console.log(line);
  }
  return sample;
}
