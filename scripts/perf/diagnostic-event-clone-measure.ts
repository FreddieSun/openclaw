// Synthetic turn-shaped dispatcher workload; run timing and allocation separately.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { monitorEventLoopDelay, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  emitTrustedDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventInput,
} from "../../src/infra/diagnostic-events.js";
import { registerDiagnosticTracePropagationBridge } from "../../src/infra/diagnostic-trace-propagation.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    turns: { type: "string", default: "100000" },
    "start-at": { type: "string", default: "0" },
    "trace-log": { type: "string" },
  },
});
const turns = parseStrictIntegerOption({
  raw: values.turns,
  fallback: 100_000,
  min: 1,
  label: "turns",
});
const startAt = parseStrictIntegerOption({
  raw: values["start-at"],
  fallback: 0,
  min: 0,
  label: "start-at",
});
assert(["counts", "timing", "allocation", "promotion"].includes(values.mode));
const traceMarker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath: "diagnostic-event-clones" })}\n`,
  );
if (values.mode === "promotion") {
  assert(
    values["trace-log"] && globalThis.gc,
    "promotion requires --expose-gc --trace-gc-nvp and --trace-log",
  );
  traceMarker("identify-start");
  globalThis.gc();
  traceMarker("identify-stop");
}

const scope = {
  sessionKey: "agent:synthetic:main",
  sessionId: "synthetic-session",
  runId: "synthetic-run",
};
const model = {
  ...scope,
  callId: "synthetic-call",
  provider: "synthetic",
  model: "synthetic-model",
};
const tool = {
  ...scope,
  toolName: "read",
  toolCallId: "synthetic-tool",
  toolSource: "core" as const,
  paramsSummary: { kind: "object" as const },
};
const events: DiagnosticEventInput[] = [
  { type: "message.received", ...scope, source: "gateway", channel: "webchat" },
  { type: "session.state", ...scope, state: "processing", prevState: "idle" },
  { type: "run.started", ...scope },
  { type: "model.call.started", ...model },
  { type: "model.call.completed", ...model, durationMs: 25, usage: { input: 1024, output: 64 } },
  { type: "tool.execution.started", ...tool },
  { type: "tool.execution.completed", ...tool, durationMs: 5 },
  { type: "model.call.started", ...model, callId: "synthetic-call-2" },
  {
    type: "model.call.completed",
    ...model,
    callId: "synthetic-call-2",
    durationMs: 25,
    usage: { input: 1536, output: 128 },
  },
  {
    type: "model.usage",
    ...scope,
    provider: "synthetic",
    model: "synthetic-model",
    usage: { input: 2560, output: 192 },
    context: { limit: 32768, used: 2752 },
  },
  { type: "run.completed", ...scope, durationMs: 60, outcome: "completed" },
  { type: "message.processed", ...scope, channel: "webchat", outcome: "completed", durationMs: 60 },
  { type: "session.state", ...scope, state: "idle", prevState: "processing" },
];
let deliveries = 0;
let toolDeliveries = 0;
let prepared = 0;
for (let index = 0; index < 2; index++) {
  onTrustedInternalDiagnosticEvent(
    () => {
      deliveries++;
    },
    undefined,
    { includePrivateData: false },
  );
}
onTrustedToolExecutionEvent(() => {
  toolDeliveries++;
});
registerDiagnosticTracePropagationBridge({
  shouldPrepareEvent: (event: DiagnosticEventInput) =>
    event.type === "model.call.started" || event.type === "tool.execution.started",
  prepareEvent: () => {
    prepared++;
  },
  resolveTraceContext: (trace) => trace,
});

async function run(count: number) {
  for (let turn = 0; turn < count; turn++) {
    for (const event of events) {
      emitTrustedDiagnosticEvent(event);
    }
    // Bound the queue to a normal turn cohort; never benchmark drops as savings.
    if (turn % 32 === 31) {
      await waitForDiagnosticEventsDrained();
    }
  }
  await waitForDiagnosticEventsDrained();
}
const clones: Record<string, number> = {};
const originalClone = globalThis.structuredClone;
if (values.mode === "counts") {
  globalThis.structuredClone = (value, options) => {
    const type =
      value && typeof value === "object" && "type" in value ? String(value.type) : "private/other";
    clones[type] = (clones[type] ?? 0) + 1;
    return originalClone(value, options);
  };
  try {
    await run(1);
  } finally {
    globalThis.structuredClone = originalClone;
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      eventsPerTurn: events.length,
      events: events.map(({ type }) => type),
      clones,
      clonesPerTurn: Object.values(clones).reduce((sum, n) => sum + n, 0),
      deliveries,
      toolDeliveries,
      prepared,
    }),
  );
} else {
  await run(2_000);
  deliveries = 0;
  toolDeliveries = 0;
  prepared = 0;
  if (startAt) {
    assert(startAt > Date.now(), "missed synchronized start");
    await delay(startAt - Date.now());
  }
  const gc: Record<string, number[]> = {};
  const record = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      const kind = (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind;
      (gc[kind] ??= []).push(entry.duration);
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  const lag = monitorEventLoopDelay({ resolution: 1 });
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    lag.enable();
    await delay(10);
    observer.observe({ entryTypes: ["gc"] });
  }
  const startedAtEpochMs = Date.now();
  if (values.mode === "promotion") {
    traceMarker("diagnostics-start");
  }
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  await run(turns);
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const endedAtEpochMs = Date.now();
  if (values.mode === "promotion") {
    traceMarker("diagnostics-stop");
  }
  let sampledBytes: number | undefined;
  let allocationSamples: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
    sampledBytes = allocated(profile.head);
    allocationSamples = profile.samples.length;
  } else {
    await immediate();
    record(observer.takeRecords());
    observer.disconnect();
    lag.disable();
  }
  assert.equal(deliveries, turns * events.length * 2);
  assert.equal(toolDeliveries, turns * 2);
  assert.equal(prepared, turns * 3);
  const summaries = Object.fromEntries(
    Object.entries(gc).map(([kind, pauses]) => {
      pauses.sort((a, b) => a - b);
      return [
        kind,
        {
          count: pauses.length,
          totalMs: pauses.reduce((sum, n) => sum + n, 0),
          maxMs: pauses.at(-1),
          p95Ms: pauses[Math.ceil(pauses.length * 0.95) - 1],
          p99Ms: pauses[Math.ceil(pauses.length * 0.99) - 1],
        },
      ];
    }),
  );
  console.log(
    JSON.stringify({
      mode: values.mode,
      node: process.version,
      turns,
      events: turns * events.length,
      startedAtEpochMs,
      endedAtEpochMs,
      wallMs,
      cpuUsPerEvent: (cpu.user + cpu.system) / (turns * events.length),
      sampledBytesPerEvent:
        sampledBytes === undefined ? undefined : sampledBytes / (turns * events.length),
      allocationSamples,
      promotion:
        values.mode === "promotion" && values["trace-log"]
          ? readGatewayGcTrace(values["trace-log"], "diagnostic-event-clones", "diagnostics")
          : undefined,
      gc: summaries,
      eventLoop:
        values.mode === "timing"
          ? {
              count: lag.count,
              p95Ms: lag.percentile(95) / 1e6,
              p99Ms: lag.percentile(99) / 1e6,
              maxMs: lag.max / 1e6,
            }
          : undefined,
      deliveries,
      toolDeliveries,
      prepared,
    }),
  );
}
