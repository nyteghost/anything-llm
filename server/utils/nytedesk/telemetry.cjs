"use strict";

/**
 * Read-only system telemetry for the NyteDesk dashboard.
 *
 * Only Node's own `os` counters are read: CPU time and memory of the host
 * running the NyteDesk server. Nothing is executed (no nvidia-smi, no shell,
 * no child processes) and no engine is contacted, so GPU, VRAM, temperature,
 * tokens per second and context usage are reported as unavailable with a
 * reason, never estimated or simulated.
 */
const os = require("node:os");

const GPU_UNAVAILABLE =
  "No GPU telemetry source is configured. NyteDesk does not run nvidia-smi or other host tools to collect it.";
const INFERENCE_UNAVAILABLE =
  "Engines do not report throughput or context usage to NyteDesk yet.";

function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * CPU utilization needs two samples; the first call reports null with a reason.
 * All sources are injectable for tests.
 */
function createTelemetry(sources = {}) {
  const now = sources.now ?? (() => Date.now());
  const cpus = sources.cpus ?? os.cpus;
  const totalmem = sources.totalmem ?? os.totalmem;
  const freemem = sources.freemem ?? os.freemem;
  let previous = null;

  return {
    sample({ engine = null } = {}) {
      const at = now();
      const list = cpus();
      const totals = cpuTotals(list);
      let cpuPercent = null;
      if (previous && totals.total > previous.total) {
        const busy =
          1 - (totals.idle - previous.idle) / (totals.total - previous.total);
        cpuPercent = Math.round(Math.min(Math.max(busy, 0), 1) * 1000) / 10;
      }
      previous = totals;
      const memoryTotalBytes = totalmem();
      const memoryUsedBytes = memoryTotalBytes - freemem();
      return {
        sampledAt: new Date(at).toISOString(),
        source: "nytedesk-server-host",
        host: {
          cpuPercent,
          cpuReason: cpuPercent === null ? "Needs a second sample" : null,
          cpuCount: list.length,
          memoryUsedBytes,
          memoryTotalBytes,
        },
        gpu: {
          available: false,
          reason: GPU_UNAVAILABLE,
          utilizationPercent: null,
          vramUsedBytes: null,
          vramTotalBytes: null,
          temperatureC: null,
        },
        inference: {
          engineId: engine?.engineId ?? null,
          model: engine?.model ?? null,
          contextWindow: engine?.contextWindow ?? null,
          available: false,
          reason: INFERENCE_UNAVAILABLE,
          tokensPerSecond: null,
          contextUsedTokens: null,
        },
      };
    },
  };
}

module.exports = { createTelemetry, GPU_UNAVAILABLE, INFERENCE_UNAVAILABLE };
