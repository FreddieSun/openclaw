// Correlated CLI tool results already carry their started args; display-only
// results must not duplicate that potentially large payload.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runCliAgentWithLifecycle } from "../../auto-reply/reply/agent-runner-cli-dispatch.js";
import type { GetReplyOptions } from "../../auto-reply/types.js";
import { createChannelProgressDraftCompositor } from "../../channels/progress-draft-compositor.js";
import {
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  updateMcpLoopbackToolCallCapture,
} from "../../gateway/mcp-http.loopback-runtime.js";
import {
  type AgentEventRuntimePayload,
  emitAgentEvent,
  onAgentEvent,
} from "../../infra/agent-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext, buildToolTracking } from "./execute-events.tool-result-args.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

const cliDispatchState = vi.hoisted(() => ({ runCliAgentMock: vi.fn() }));
vi.mock("../cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));
afterEach(() => {
  cliDispatchState.runCliAgentMock.mockReset();
  resetGlobalHookRunner();
});

function eventFixture(context: PreparedCliRunContext, tracking = buildToolTracking()) {
  const handlers = createCliEventHandlers({
    context,
    toolTracking: tracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const events: AgentEventRuntimePayload[] = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === context.params.runId) {
      events.push(event);
    }
  });
  onTestFinished(dispose);
  const start = (
    toolCallId: string,
    name: string,
    args: Record<string, unknown> = {},
    kind: Parameters<typeof handlers.emitParsedToolUseStart>[0]["kind"] = "mcp_tool_use",
  ) => handlers.emitParsedToolUseStart({ toolCallId, name, args, kind });
  const emitResult = (toolCallId: string, name: string, isError = false, result?: unknown) =>
    handlers.emitParsedToolResult({ toolCallId, name, isError, result });
  return { handlers, events, start, emitResult };
}

function startRecord(id: string, name: string, input: Record<string, unknown>) {
  return (
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    }) + "\n"
  );
}

function resultRecord(id: string, content: string, isError = false) {
  return (
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    }) + "\n"
  );
}

function displayParser(handlers: ReturnType<typeof createCliEventHandlers>) {
  return createCliJsonlStreamingParser({
    providerId: "claude-cli",
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    onAssistantDelta: vi.fn(),
    onToolUseStart: handlers.emitCliDisplayToolUseStart,
    onToolResult: handlers.emitCliDisplayToolResult,
  });
}

describe("cli tool result events", () => {
  it.each([undefined, "side-question"] as const)(
    "keeps input progress separate from execution in %s mode",
    (executionMode) => {
      const context = buildContext(`input-${executionMode ?? "normal"}`);
      context.params.executionMode = executionMode;
      context.params.onExecutionPhase = vi.fn();
      const tracking = buildToolTracking();
      const { handlers, events } = eventFixture(context, tracking);
      handlers.emitCliToolInputDelta({
        toolCallId: "write",
        name: "write",
        diff: { added: 2, removed: 0 },
      });
      handlers.finalizeParsedTools();
      expect(context.params.onExecutionPhase).not.toHaveBeenCalled();
      expect(tracking.handleCliToolUseStart).not.toHaveBeenCalled();
      expect(handlers.hasObservedCliActivity()).toBe(true);
      expect(events.map(({ stream, data }) => ({ stream, data }))).toEqual(
        executionMode
          ? []
          : [
              {
                stream: "tool",
                data: {
                  phase: "input_delta",
                  toolCallId: "write",
                  name: "write",
                  diff: { added: 2, removed: 0 },
                },
              },
            ],
      );
    },
  );

  it.each([
    ["poll", "kill", false],
    ["kill", "poll", true],
  ] as const)(
    "uses correlated executed arguments for %s to %s without changing raw arguments",
    (requested, executed, quiet) => {
      const context = buildContext(`rewrite-${requested}`);
      const tracking = createCliToolTracking(context);
      tracking.beginGatewayCapture(context.params.runId, () => {});
      const { events, start, emitResult } = eventFixture(context, tracking);
      const args = { action: requested, sessionId: "job" };
      onTestFinished(() => tracking.finalizeCapture(() => {}));
      start("call", "mcp__openclaw__process", args);
      const capture = markMcpLoopbackToolCallStarted({
        captureKey: context.params.runId,
        toolName: "process",
        args,
      });
      if (!capture) {
        throw new Error("Expected loopback capture");
      }
      updateMcpLoopbackToolCallCapture(capture, {
        toolName: "process",
        args: { ...args, action: executed },
      });
      emitResult("call", "mcp__openclaw__process", false, "result");
      const terminal = events.find(
        (event) => event.stream === "item" && event.data.phase === "end",
      );
      expect(Boolean(terminal?.data.hideFromChannelProgress)).toBe(quiet);
      expect(
        events.find((event) => event.stream === "tool" && event.data.phase === "result")?.data.args,
      ).toEqual(args);
    },
  );

  it("projects parsed loopback waits once without changing raw names or display result args", () => {
    const runId = "parsed-activity";
    const { handlers, events } = eventFixture(buildContext(runId));
    const parser = displayParser(handlers);
    handlers.emitCliCommentaryText("Let me check that for you.");
    expect(events).toMatchObject([
      {
        stream: "item",
        data: { kind: "preamble", phase: "end", progressText: "Let me check that for you." },
      },
    ]);
    for (const [toolCallId, name, args, isError, quiet] of [
      ["poll", "mcp__openclaw__process", { action: "poll", sessionId: "process-1" }, false, true],
      ["failed", "mcp__openclaw__process", { action: "poll", sessionId: "missing" }, true, false],
      ["kill", "mcp__openclaw__process", { action: "kill", sessionId: "process-1" }, false, false],
      ["yield", "mcp__openclaw__sessions_yield", {}, false, true],
      ["third-party", "mcp__other__sessions_yield", {}, false, false],
    ] as const) {
      parser.push(startRecord(toolCallId, name, args));
      parser.push(resultRecord(toolCallId, "raw result", isError));
      const operation = events.filter((event) => event.data.toolCallId === toolCallId);
      expect(operation.map((event) => [event.stream, event.data.phase])).toEqual([
        ["item", "start"],
        ["tool", "start"],
        ["tool", "result"],
        ["item", "end"],
      ]);
      expect(operation[2]?.data).toMatchObject({ name, result: "raw result", isError });
      expect(operation[2]?.data.args).toBeUndefined();
      expect(operation[2]?.data.hideFromChannelProgress).toBeUndefined();
      expect(Boolean(operation[3]?.data.hideFromChannelProgress)).toBe(quiet);
      expect(operation[3]?.data.name).toBe(name.replace(/^mcp__openclaw__/, ""));
    }
  });

  it.each([false, true])(
    "delivers native completions once to canonical matchers unless isolated (%s)",
    async (isolatedCompletion) => {
      const observed: unknown[] = [];
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "after_tool_call",
            matcher: ["exec", "web_fetch"],
            handler: (event) => observed.push(event),
          },
        ]),
      );
      const context = buildContext(`native-completion-${isolatedCompletion}`);
      if (isolatedCompletion) {
        context.params.isolatedCompletion = true;
      }
      const { handlers, start } = eventFixture(context, createCliToolTracking(context));
      start("native-exec", "Bash", { command: "pwd" }, "tool_use");
      const completed = {
        toolCallId: "native-exec",
        name: "Bash",
        isError: false,
        result: "/workspace",
      };
      handlers.emitParsedToolResult(completed);
      handlers.emitParsedToolResult(completed);
      handlers.emitCliDisplayToolUseStart({
        toolCallId: "native-fetch",
        name: "WebFetch",
        kind: "tool_use",
        args: { url: "https://example.com" },
      });
      handlers.emitCliDisplayToolResult({
        toolCallId: "native-fetch",
        name: "WebFetch",
        isError: true,
        result: { error: "request failed" },
      });
      for (const name of ["mcp__openclaw__exec", "mcp_openclaw_exec"]) {
        handlers.emitParsedToolUseStart({
          toolCallId: name,
          name,
          kind: "mcp_tool_use",
          args: { command: "pwd" },
        });
        handlers.emitParsedToolResult({ ...completed, toolCallId: name, name });
      }
      handlers.emitParsedToolResult({ ...completed, toolCallId: "unknown-call", name: "" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await vi.waitFor(() =>
        expect(observed).toMatchObject(
          isolatedCompletion
            ? []
            : [
                {
                  toolName: "exec",
                  toolCallId: "native-exec",
                  params: { command: "pwd" },
                  result: "/workspace",
                },
                {
                  toolName: "web_fetch",
                  toolCallId: "native-fetch",
                  params: { url: "https://example.com" },
                  error: "request failed",
                },
              ],
        ),
      );
    },
  );

  it("keeps named result-only completions and duplicate claims scoped to their parser run", async () => {
    const observed: unknown[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          matcher: ["exec"],
          handler: (event) => observed.push(event),
        },
      ]),
    );
    const parsers = ["previous", "current"].map((runId) => {
      const context = buildContext(runId);
      const handlers = createCliEventHandlers({
        context,
        toolTracking: createCliToolTracking(context),
        getRunState: () => ({ failed: false, error: undefined }),
      });
      return createCliJsonlStreamingParser({
        backend: { command: "synthetic", output: "jsonl" },
        providerId: "synthetic-cli",
        parseJsonlEvent: (line) => ({
          kind: "toolResult",
          toolCallId: "reused-id",
          name: "Bash",
          result: line.trim(),
        }),
        onAssistantDelta: () => {},
        onDisplayToolResult: handlers.emitCliDisplayToolResult,
      });
    });
    parsers[1]?.push('{"output":"current"}\n{"output":"duplicate"}\n');
    parsers[0]?.push('{"output":"late previous"}\n');
    await vi.waitFor(() =>
      expect(observed).toMatchObject([
        {
          toolName: "exec",
          runId: "current",
          toolCallId: "reused-id",
          params: {},
          result: '{"output":"current"}',
        },
        {
          toolName: "exec",
          runId: "previous",
          toolCallId: "reused-id",
          params: {},
          result: '{"output":"late previous"}',
        },
      ]),
    );
  });

  it("keeps correlated result args without adding them to display results", () => {
    const runId = "run-tool-result-args";
    const { handlers, events, start, emitResult } = eventFixture(buildContext(runId));

    start("call-1", "Bash", { command: "nope-not-a-command" }, "tool_use");
    emitResult("call-1", "Bash", true, "bash: nope-not-a-command: command not found");
    emitResult("call-1", "Bash", false, "duplicate terminal");
    handlers.emitCliDisplayToolUseStart({
      toolCallId: "call-2",
      name: "write",
      kind: "tool_use",
      args: { path: "note.txt", content: "hello" },
    });
    handlers.emitCliDisplayToolResult({
      toolCallId: "call-2",
      name: "write",
      isError: false,
      result: "wrote note.txt",
    });
    // The display result also releases correlation state for this call id.
    emitResult("call-2", "write", false, "duplicate terminal");

    const results = events.filter(
      (event) => event.stream === "tool" && event.data.phase === "result",
    );
    expect(results[0]?.data.args).toEqual({ command: "nope-not-a-command" });
    expect(results[0]?.data.isError).toBe(true);
    expect(results[1]?.data.args).toBeUndefined();
    expect(results[2]?.data.isError).toBe(false);
    expect(results[2]?.data.args).toBeUndefined();
    expect(results[3]?.data.args).toBeUndefined();
  });
});

describe("CLI progress-card plan projection", () => {
  it.each(["replacement", "clear", "ambiguous"] as const)(
    "projects only unambiguous executed progress-card arguments: %s",
    (mode) => {
      const runId = `executed-plan-${mode}`;
      const context = buildContext(runId);
      context.resultContentSourceByToolName = new Map([["progress_card", "network"]]);
      const tracking = createCliToolTracking(context);
      tracking.beginGatewayCapture(runId, () => {});
      const { events, start, emitResult } = eventFixture(context, tracking);
      const plan = { plan: [{ step: "Prepared checklist", status: "in_progress" }] };
      const requested = mode === "replacement" ? {} : plan;
      const executed = mode === "clear" ? {} : plan;
      const name = "mcp__openclaw__progress_card";
      onTestFinished(() => tracking.finalizeCapture(() => {}));
      start("card", name, requested);
      if (mode === "ambiguous") {
        start("peer", name, requested);
      }
      const capture = markMcpLoopbackToolCallStarted({
        captureKey: runId,
        toolName: "progress_card",
        args: requested,
      });
      if (!capture) {
        throw new Error("Expected loopback capture");
      }
      updateMcpLoopbackToolCallCapture(capture, { toolName: "progress_card", args: executed });
      recordMcpLoopbackToolCallResult({
        captureHandle: capture,
        toolName: "progress_card",
        args: executed,
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(capture);
      emitResult("card", name);
      const result = events.find(
        (event) => event.stream === "tool" && event.data.phase === "result",
      );
      expect(result?.data.resultContentSource).toBe("network");
      expect(
        events
          .filter((event) => event.data.toolCallId === "card")
          .map((event) => [event.stream, event.data.phase]),
      ).toEqual([
        ["item", "start"],
        ["tool", "start"],
        ["tool", "result"],
        ["item", "end"],
      ]);
      const plans = events.filter((event) => event.stream === "plan");
      if (mode === "ambiguous") {
        expect(plans).toEqual([]);
      } else {
        expect(plans).toHaveLength(1);
        expect(plans[0]?.data.steps).toEqual(mode === "clear" ? [] : plan.plan);
      }
      expect(
        events.find((event) => event.stream === "tool" && event.data.phase === "result")?.data.args,
      ).toEqual(requested);
    },
  );

  it.each([
    ["progress_card", false],
    ["mcp__openclaw__progress_card", true],
  ] as const)(
    "keeps parsed display-only %s clears outside tracked plan state (tracked result first: %s)",
    (name, trackedResultFirst) => {
      const runId = `display-clear-${name}`;
      const tracking = buildToolTracking();
      const { handlers, events, start, emitResult } = eventFixture(buildContext(runId), tracking);
      const parser = displayParser(handlers);
      start("tracked-plan", name, { plan: [{ step: "Keep working", status: "in_progress" }] });
      emitResult("tracked-plan", name);
      parser.push(startRecord("display-clear", name, {}));
      if (trackedResultFirst) {
        emitResult("display-clear", name);
      }
      parser.push(resultRecord("display-clear", "done"));
      // Neither ordering may promote a display-only start into authoritative plan state.
      if (!trackedResultFirst) {
        emitResult("display-clear", name);
      }
      const plans = () => events.filter((event) => event.stream === "plan");
      expect(plans()).toHaveLength(1);
      expect(plans()[0]?.data.steps).toEqual([{ step: "Keep working", status: "in_progress" }]);
      expect(tracking.handleCliToolUseStart).toHaveBeenCalledTimes(1);
      expect(tracking.handleCliToolResult).toHaveBeenCalledTimes(2);
      start("tracked-clear", name, {});
      emitResult("tracked-clear", name);
      expect(plans()).toHaveLength(2);
      expect(plans()[1]?.data.steps).toEqual([]);
      expect(handlers.getToolSummary()).toEqual({ calls: 3, tools: [name], failures: 0 });
    },
  );

  it.each([
    "failed",
    "malformed",
    "other MCP server",
    "uncorrelated",
    "side question",
    "display only",
  ])("does not fabricate plan state for %s results", (mode) => {
    const name = mode === "other MCP server" ? "mcp__other__progress_card" : "progress_card";
    const args = {
      plan: mode === "malformed" ? "not a plan" : [{ step: "Inspect", status: "pending" }],
    };
    const runId = "no-plan";
    const context = buildContext(runId);
    if (mode === "side question") {
      context.params.executionMode = "side-question";
    }
    const { handlers, events } = eventFixture(context);
    const start = { toolCallId: "card", name, kind: "mcp_tool_use" as const, args };
    if (mode !== "uncorrelated") {
      if (mode === "display only") {
        handlers.emitCliDisplayToolUseStart(start);
      } else {
        handlers.emitParsedToolUseStart(start);
      }
    }
    const result = { toolCallId: "card", name, isError: mode === "failed", result: "receipt" };
    if (mode === "display only") {
      handlers.emitCliDisplayToolResult(result);
    } else {
      handlers.emitParsedToolResult(result);
    }
    expect(events.filter((event) => event.stream === "plan")).toEqual([]);
    if (mode === "side question") {
      expect(events).toEqual([]);
    }
  });
});

describe("CLI plan channel bridge", () => {
  it.each([
    { name: "progress_card", suppressed: false, clearCard: false },
    { name: "mcp__openclaw__update_plan", suppressed: false, clearCard: true },
    { name: "mcp__openclaw__progress_card", suppressed: true, clearCard: true },
  ])(
    "bridges $name with suppression=$suppressed and clear=$clearCard without completing the run",
    async ({ name, suppressed, clearCard }) => {
      const runId = `progress-bridge-${name}`;
      const render = vi.fn((_text: string, _options?: unknown) => true);
      const deleteCurrent = vi.fn(async () => {});
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: false, toolProgress: true } } },
        mode: "progress",
        active: true,
        seed: runId,
        update: render,
        deleteCurrent,
      });
      const onPlanUpdate = vi.fn(
        async (update: Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0]) => {
          await progress.pushPlanProgress(update.steps ?? [], update);
        },
      );
      const lifecycle: string[] = [];
      const dispose = onAgentEvent((event) => {
        if (event.runId === runId && event.stream === "lifecycle") {
          lifecycle.push(String(event.data.phase));
        }
      });
      cliDispatchState.runCliAgentMock.mockImplementationOnce(
        async (params: PreparedCliRunContext["params"]) => {
          const handlers = createCliEventHandlers({
            context: { ...buildContext(runId), params },
            toolTracking: buildToolTracking(),
            getRunState: () => ({ failed: false, error: undefined }),
          });
          const parser = createCliJsonlStreamingParser({
            providerId: "claude-cli",
            backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
            onAssistantDelta: handlers.emitCliAssistantDelta,
            onToolUseStart: handlers.emitParsedToolUseStart,
            onToolResult: handlers.emitParsedToolResult,
          });
          parser.push(
            startRecord("plan", name, {
              plan: [
                { step: "Inspect\u200b", status: "completed" },
                { step: "Repair", status: "completed" },
              ],
            }),
          );
          const resultLine = resultRecord("plan", "updated");
          parser.push(resultLine);
          parser.push(resultLine);
          if (clearCard) {
            const call = (id: string, input: Record<string, unknown>) => {
              parser.push(startRecord(id, name, input));
              return resultRecord(id, "updated");
            };
            const clearResult = call("clear", {});
            parser.push(clearResult);
            parser.push(clearResult);
            parser.push(
              call("replacement", {
                plan: [{ step: "Replacement", status: "in_progress" }],
              }),
            );
            // A late duplicate clear must not retract the newer checklist.
            parser.push(clearResult);
          }
          emitAgentEvent({
            runId: "unrelated-run",
            stream: "plan",
            data: { steps: ["Do not deliver"] },
          });
          expect(lifecycle).not.toContain("end");
          return { payloads: [{ text: "Final task answer" }], meta: { durationMs: 1 } };
        },
      );
      try {
        const result = await runCliAgentWithLifecycle({
          runId,
          onPlanUpdate,
          suppressAssistantBridge: suppressed,
          runParams: buildContext(runId).params,
        });
        expect(onPlanUpdate).toHaveBeenCalledTimes(suppressed ? 0 : clearCard ? 3 : 1);
        if (!suppressed) {
          expect(onPlanUpdate).toHaveBeenCalledWith({
            phase: "update",
            title: "Plan updated",
            explanation: "2/2 complete",
            source: "openclaw",
            steps: [
              { step: "Inspect", status: "completed" },
              { step: "Repair", status: "completed" },
            ],
          });
        }
        if (suppressed) {
          expect(render).not.toHaveBeenCalled();
          expect(deleteCurrent).not.toHaveBeenCalled();
        } else {
          expect(render).toHaveBeenCalledWith(
            expect.stringContaining("2/2 complete"),
            expect.objectContaining({
              snapshot: expect.objectContaining({
                plan: [
                  { step: "Inspect", status: "completed" },
                  { step: "Repair", status: "completed" },
                ],
              }),
            }),
          );
          const rendered = render.mock.calls.at(-1)?.[0];
          if (clearCard) {
            expect(onPlanUpdate).toHaveBeenNthCalledWith(2, {
              phase: "update",
              title: "Plan updated",
              source: "openclaw",
              steps: [],
            });
            expect(onPlanUpdate).toHaveBeenNthCalledWith(
              3,
              expect.objectContaining({
                steps: [{ step: "Replacement", status: "in_progress" }],
              }),
            );
            expect(deleteCurrent).toHaveBeenCalledTimes(1);
            expect(rendered).toContain("Replacement");
            expect(rendered).not.toContain("Inspect");
          } else {
            expect(deleteCurrent).not.toHaveBeenCalled();
            expect(rendered).toContain("Inspect");
            expect(rendered).toContain("Repair");
          }
        }
        expect(result.payloads).toEqual([{ text: "Final task answer" }]);
        expect(lifecycle).toEqual(["start"]);
      } finally {
        progress.cancel();
        dispose();
      }
    },
  );
});

describe("CLI prepared live output", () => {
  it("uses the current output replacements for commentary, streaming, and completion", () => {
    const context = buildContext("cli-live-output-policy");
    context.backendResolved.textTransforms = { output: [{ from: /MARKER/g, to: "first" }] };
    const { handlers, events } = eventFixture(context);
    handlers.emitCliCommentaryText("MARKER");
    context.backendResolved.textTransforms = { output: [{ from: /MARKER/g, to: "second" }] };
    handlers.emitCliAssistantDelta({ text: "MARKER", delta: "MARKER" });
    handlers.emitCliCompletedReply("MARKER", 0);
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ progressText: "first" }),
      expect.objectContaining({ text: "second", delta: "second" }),
      expect.objectContaining({ completedText: "second" }),
    ]);
  });

  it.each(["NO_REPLY.", '"NO_REPLY"', '{"action":"NO_REPLY"}', "NO_REPLY\nNO_REPLY"])(
    "preserves ordinary producer output %j",
    (raw) => {
      const { handlers, events } = eventFixture(buildContext("cli-visible-control"));
      const text = raw.startsWith("NO_REPLY\n") ? raw.slice(9) : raw;
      handlers.emitCliAssistantDelta({ text: raw, delta: raw });
      handlers.emitCliCompletedReply(raw, 0);
      handlers.emitCliCommentaryText(raw);
      expect(events.map((event) => event.data)).toEqual([
        expect.objectContaining({ text, delta: text }),
        expect.objectContaining({ completedText: text }),
        expect.objectContaining({ progressText: text }),
      ]);
    },
  );

  it.each(["NO_REPLY", "no_reply", "No_Reply"])(
    "withholds possible %s controls before releasing the full leading-line suffix",
    (token) => {
      const { handlers, events } = eventFixture(buildContext("cli-control-prefix"));
      handlers.emitCliAssistantDelta({ text: token.slice(0, 2), delta: token.slice(0, 2) });
      handlers.emitCliAssistantDelta({ text: token, delta: token.slice(2) });
      handlers.emitCliCompletedReply(token, 0);
      handlers.emitCliCommentaryText(` \t${token}\n`);
      expect(events).toEqual([]);
      handlers.emitCliAssistantDelta({
        text: `${token}\n  Answer.\n`,
        delta: `${token}\n  Answer.\n`,
      });
      expect(events).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ text: "  Answer.\n", delta: "  Answer.\n" }),
        }),
      ]);
    },
  );
});
