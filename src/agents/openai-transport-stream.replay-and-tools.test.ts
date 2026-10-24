import OpenAI from "openai";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { serializeModelRequestBody } from "../../packages/ai/src/transports/model-request-body.js";
import { buildOpenAICompletionsParams } from "./openai-transport-stream.js";
import {
  buildOpenAIResponsesParams,
  makeCompletionsModel,
  makeResponsesModel,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

type ReplayContextSpec = {
  source?: Pick<Model, "api" | "id" | "provider">;
  provider?: string;
  model?: string;
  stopReason?: "stop" | "toolUse";
  thinking?: {
    signature: string | Record<string, unknown>;
    replayMetadata?: unknown;
  };
  text?: true;
  toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: unknown }>;
  results?: ReadonlyArray<{
    id: string;
    name: string;
    content: readonly unknown[];
    timestamp?: number;
  }>;
  before?: readonly unknown[];
  after?: readonly unknown[];
};

function replayContext(spec: ReplayContextSpec) {
  const content: Array<Record<string, unknown>> = [];
  if (spec.thinking) {
    content.push({
      type: "thinking",
      thinking: "Need a tool.",
      thinkingSignature:
        typeof spec.thinking.signature === "string"
          ? spec.thinking.signature
          : JSON.stringify(spec.thinking.signature),
      ...(spec.thinking.replayMetadata === undefined
        ? {}
        : { openclawReasoningReplay: spec.thinking.replayMetadata }),
    });
  }
  if (spec.text) {
    content.push({
      type: "text",
      text: "Checking the price.",
      textSignature: JSON.stringify({ v: 1, id: "msg_prior", phase: "commentary" }),
    });
  }
  for (const toolCall of spec.toolCalls ?? []) {
    content.push({ type: "toolCall", ...toolCall });
  }
  const messages = [
    ...(spec.before ?? []),
    {
      role: "assistant",
      api: spec.source?.api ?? "openai-responses",
      provider: spec.source?.provider ?? spec.provider ?? "openai",
      model: spec.source?.id ?? spec.model ?? "gpt-5.5",
      usage: createZeroUsageFixture(),
      stopReason: spec.stopReason ?? "toolUse",
      timestamp: 1,
      content,
    },
    ...(spec.results ?? []).map(({ id, name, content: resultContent, timestamp = 2 }) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: resultContent,
      isError: false,
      timestamp,
    })),
    ...(spec.after ?? []),
  ];
  return { systemPrompt: "system", messages, tools: [] } as never;
}

function responsesModelFixture(id = "gpt-5.5", name = id) {
  return makeResponsesModel({ id, name });
}

type ReplayItem = {
  type?: string;
  role?: string;
  id?: string;
  call_id?: string;
  phase?: string;
  status?: string;
  encrypted_content?: string;
  summary?: unknown;
  output?: unknown;
  arguments?: string;
};
type ReplayParams = { store?: boolean; input?: ReplayItem[] };

const session = { sessionId: "session-123" };
const reasoning = { type: "reasoning", id: "rs_prior", encrypted_content: "ciphertext" };
const proxyModel = makeResponsesModel({
  id: "gpt-5.4",
  api: "openai-chatgpt-responses",
  baseUrl: "https://proxy.example.com/v1",
});
const priceCall = { id: "call_abc|fc_prior", name: "price_lookup", arguments: { symbol: "SOL" } };
const priceResult = {
  id: priceCall.id,
  name: priceCall.name,
  content: [{ type: "text", text: "$83.95" }],
};

function toolContext(id: string, name: string, content: readonly unknown[]) {
  return replayContext({
    toolCalls: [{ id, name, arguments: {} }],
    results: [{ id, name, content }],
  });
}

function recover(
  create: ReturnType<typeof vi.fn>,
  request: unknown,
  onCompactionRejected?: () => void,
) {
  return testing.createResponsesStreamWithRecovery({
    client: { responses: { create } } as never,
    request: request as never,
    buildFullHistoryRequest: () => request as never,
    requestOptions: undefined,
    model: responsesModelFixture(),
    onCompactionRejected,
  });
}

const encryptedError = () =>
  Object.assign(new Error("invalid encrypted content"), {
    code: "invalid_encrypted_content",
  });
const mixedRequest = () => ({
  model: "gpt-5.5",
  stream: true,
  input: [
    { type: "reasoning", encrypted_content: "reasoning", summary: [] },
    { type: "compaction", encrypted_content: "compaction" },
  ],
});
function rejectedResponse(error: Error) {
  return { withResponse: vi.fn().mockRejectedValue(error) };
}

function emptyResponsesContext() {
  return { systemPrompt: "system", messages: [], tools: [] } as never;
}

describe("openai transport stream", () => {
  it.each([
    {
      name: "disabled store",
      model: makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "mycodex",
        baseUrl: "http://127.0.0.1:8317/v1",
      }),
      ids: false,
      encrypted: false,
    },
    {
      name: "explicit replay",
      model: responsesModelFixture("gpt-5.4"),
      ids: true,
      encrypted: false,
    },
    {
      name: "custom Codex-compatible",
      model: proxyModel,
      ids: false,
      encrypted: true,
    },
    { name: "embedded provenance", model: proxyModel, ids: false, encrypted: true, embedded: true },
  ])("handles replay ids with $name", ({ model, ids, encrypted, embedded }) => {
    const options = {
      ...session,
      ...(encrypted ? { authProfileId: "openai:oauth" } : {}),
      ...(ids ? { replayResponsesItemIds: true } : {}),
    };
    const request = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: {
          signature: embedded
            ? {
                ...reasoning,
                __openclaw_replay: testing.buildOpenAIResponsesReasoningReplayMetadata(
                  model,
                  options,
                ),
              }
            : reasoning,
          ...(encrypted && !embedded
            ? {
                replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, options),
              }
            : {}),
        },
        text: true,
        toolCalls: [priceCall],
        results: [priceResult],
      }),
      options,
    );
    const params = JSON.parse(
      new TextDecoder().decode(serializeModelRequestBody(request).body),
    ) as ReplayParams;
    if (!ids) {
      expect(params.store).toBe(false);
    }
    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
      id: ids ? "rs_prior" : undefined,
    });
    if (encrypted) {
      expect(reasoningItem?.encrypted_content).toBe("ciphertext");
    } else {
      expect(reasoningItem).not.toHaveProperty("encrypted_content");
    }
    expect(reasoningItem).not.toHaveProperty("__openclaw_replay");
    expectRecordFields(
      params.input?.find((item) => item.type === "message" && item.role === "assistant"),
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        id: ids ? "msg_prior" : undefined,
        status: ids ? "completed" : undefined,
      },
    );
    expectRecordFields(
      params.input?.find((item) => item.type === "function_call"),
      {
        type: "function_call",
        call_id: "call_abc",
        id: ids ? "fc_prior" : undefined,
      },
    );
  });

  it("drops oversized GitHub Copilot Responses reasoning replay ids before send", () => {
    const model = makeResponsesModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
      contextWindow: 400000,
    });
    const longReasoningId = `rs_${"x".repeat(380)}`;

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: { signature: { type: "reasoning", id: longReasoningId, summary: [] } },
      }),
      { replayResponsesItemIds: true, sessionId: "session-123" },
    ) as ReplayParams;

    expect(params.input?.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("retries mixed replay without reasoning first and preserves compaction on success", async () => {
    const request = {
      model: "gpt-5.5",
      stream: true,
      input: [
        {
          type: "reasoning",
          id: "rs_prior",
          encrypted_content: "ciphertext",
          summary: [{ type: "summary_text", text: "checked" }],
          nested: { encrypted_content: "nested-ciphertext", keep: "value" },
        },
        {
          type: "compaction",
          id: "cmp_prior",
          encrypted_content: "compaction-ciphertext",
        },
        {
          type: "function_call",
          id: "fc_prior",
          call_id: "call_abc",
          name: "price_lookup",
          arguments: "{}",
        },
      ],
    };
    const recoveredStream = streamChunks([]);
    const create = vi
      .fn()
      .mockReturnValueOnce(rejectedResponse(encryptedError()))
      .mockReturnValueOnce({
        withResponse: vi.fn().mockResolvedValue({
          data: recoveredStream,
          response: new Response(null, { status: 200 }),
        }),
      });
    const onCompactionRejected = vi.fn();

    await expect(recover(create, request, onCompactionRejected)).resolves.toMatchObject({
      stream: recoveredStream,
    });

    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1]?.[0] as typeof request;
    expect(retry.input[0]).toMatchObject({
      type: "reasoning",
      id: "rs_prior",
      summary: [{ type: "summary_text", text: "checked" }],
      nested: { keep: "value" },
    });
    expect(retry.input[0]).not.toHaveProperty("encrypted_content");
    expect(retry.input[0]?.nested).not.toHaveProperty("encrypted_content");
    expect(retry.input[1]).toEqual(request.input[1]);
    expect(onCompactionRejected).not.toHaveBeenCalled();
  });

  it.each([
    { name: "final recovery failure", attempts: 3, error: new Error("final recovery failed") },
    {
      name: "unrelated reasoning-free failure",
      attempts: 2,
      error: new OpenAI.RateLimitError(
        429,
        { code: "rate_limit_exceeded", message: "rate limited", type: "rate_limit_error" },
        undefined,
        new Headers(),
      ),
    },
  ])("does not tombstone compaction or advance after $name", async ({ attempts, error }) => {
    const create = vi.fn().mockReturnValueOnce(rejectedResponse(encryptedError()));
    if (attempts === 3) {
      create.mockReturnValueOnce(rejectedResponse(encryptedError()));
    }
    create.mockReturnValueOnce(rejectedResponse(error));
    const onCompactionRejected = vi.fn();
    await expect(recover(create, mixedRequest(), onCompactionRejected)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(attempts);
    expect(onCompactionRejected).not.toHaveBeenCalled();
  });

  it("does not retry encrypted-content failures emitted after stream creation", async () => {
    const streamFailure = Object.assign(new Error("stream rejected encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const responseStream = (async function* () {
      yield { type: "response.created", response: { id: "resp_stream" } };
      throw streamFailure;
    })();
    const create = vi.fn().mockReturnValue({
      withResponse: vi.fn().mockResolvedValue({
        data: responseStream,
        response: new Response(null, { status: 200 }),
      }),
    });
    const request = {
      model: "gpt-5.5",
      stream: true,
      input: [{ type: "reasoning", encrypted_content: "reasoning", summary: [] }],
    } as never;
    const result = await recover(create, request);

    await expect(async () => {
      for await (const event of result.stream) {
        // Consume until the provider stream rejects.
        void event;
      }
    }).rejects.toBe(streamFailure);
    expect(create).toHaveBeenCalledOnce();
  });

  it("normalizes overlong Copilot Responses replay tool ids before dispatch", () => {
    const longToolItemId = "iVec" + "A".repeat(360);
    const longToolCallId = `call_ug6lFGKwZDjHfzW8H0PDQRwN|${longToolItemId}`;
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com",
      }),
      replayContext({
        provider: "github-copilot",
        before: [{ role: "user", content: "read the queue", timestamp: 0 }],
        toolCalls: [
          {
            id: longToolCallId,
            name: "exec",
            arguments: { command: "gh pr list --limit 1" },
          },
        ],
        results: [{ id: longToolCallId, name: "exec", content: [{ type: "text", text: "[]" }] }],
        after: [{ role: "user", content: "continue", timestamp: 3 }],
      }),
      session,
    ) as ReplayParams;

    const functionCall = params.input?.find((item) => item.type === "function_call");
    const functionOutput = params.input?.find((item) => item.type === "function_call_output");
    expect(functionCall).toBeDefined();
    expect(functionOutput).toBeDefined();
    expect(functionCall?.id).toBeUndefined();
    expect(functionCall?.call_id).toBe("call_ug6lFGKwZDjHfzW8H0PDQRwN");
    expect(functionOutput?.call_id).toBe(functionCall?.call_id);
    for (const item of params.input ?? []) {
      if (item.id !== undefined) {
        expect(item.id.length).toBeLessThanOrEqual(64);
      }
      if (item.call_id !== undefined) {
        expect(item.call_id.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it.each([
    { name: "empty", content: [], output: "(no output)" },
    {
      name: "payload-less image",
      content: [{ type: "image", mimeType: "image/png", data: "" }],
      output: "(no output)",
    },
    {
      name: "image-bearing",
      content: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
      output: [{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,aW1n" }],
    },
  ])("replays $name tool results", ({ content, output }) => {
    const params = buildOpenAIResponsesParams(
      content.length === 0
        ? responsesModelFixture()
        : makeResponsesModel({ id: "gpt-5.5", input: ["text", "image"] }),
      toolContext("call_shot", "screenshot", content),
      session,
    ) as ReplayParams;
    const result = params.input?.find((item) => item.type === "function_call_output");
    expectRecordFields(result, { type: "function_call_output", call_id: "call_shot", output });
    if (typeof output === "string") {
      expect(JSON.stringify(result)).not.toContain("input_image");
      expect(JSON.stringify(result)).not.toContain("see attached image");
    }
  });

  it("serializes structured tool result content into Responses output text", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture(),
      replayContext({
        toolCalls: [{ id: "call_lookup", name: "lookup", arguments: { query: "price" } }],
        results: [
          {
            id: "call_lookup",
            name: "lookup",
            content: [{ type: "json", payload: { price: 42, currency: "USD" } }],
          },
        ],
        after: [{ role: "user", content: "continue", timestamp: 3 }],
      }),
      undefined,
    ) as ReplayParams;
    const output = params.input?.find((item) => item.type === "function_call_output");
    expect(output).toBeDefined();
    expect(output?.call_id).toBe("call_lookup");
    expect(typeof output?.output).toBe("string");
    expect(output?.output).toContain("price");
    expect(output?.output).toContain("42");
    expect(output?.output).not.toBe("(see attached image)");
  });

  it("normalizes canonical reasoning casing in Responses and Chat Completions payloads", () => {
    const context = emptyResponsesContext();
    const baseModel = { id: "gpt-5.5", name: "GPT-5.5" };
    const responses = buildOpenAIResponsesParams(makeResponsesModel(baseModel), context, {
      reasoningEffort: " XHIGH ",
    } as never) as { reasoning?: unknown };
    const completions = buildOpenAICompletionsParams(makeCompletionsModel(baseModel), context, {
      reasoningEffort: " XHIGH ",
    } as never) as { reasoning_effort?: unknown };

    expect(responses.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(completions.reasoning_effort).toBe("xhigh");
  });

  it.each([
    ["web_search", "low"],
    ["lookup_weather", "minimal"],
  ] as const)("uses %s to choose reasoning effort %s", (toolName, effort) => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      compat: {
        supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      },
    });

    const params = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: toolName,
            description: "Fixture tool",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort, summary: "auto" });
  });

  it("does not reread an unreadable tool inventory length", () => {
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const responsesModel = responsesModelFixture("gpt-5.5", "GPT-5.5");
    const completionsModel = makeCompletionsModel({
      ...responsesModel,
      api: "openai-completions",
      reasoning: false,
    });
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools,
    } as never;

    expect(buildOpenAIResponsesParams(responsesModel, context, undefined)).not.toHaveProperty(
      "tools",
    );
    expect(buildOpenAICompletionsParams(completionsModel, context, undefined)).not.toHaveProperty(
      "tools",
    );
  });

  it("serializes raw string tool-call arguments without double-encoding them", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4"),
      replayContext({
        model: "gpt-5.4",
        stopReason: "stop",
        toolCalls: [{ id: "call_abc|fc_item1", name: "my_tool", arguments: "not valid json" }],
      }),
      undefined,
    ) as ReplayParams;

    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      arguments: "not valid json",
    });
  });

  it("normalizes responses tool parameters while downgrading native strict:false", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4"),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }> };

    expect(params.tools?.[0]?.strict).toBe(false);
    expectRecordFields(params.tools?.[0]?.parameters, {
      type: "object",
      properties: { path: { type: "string" } },
      required: [],
    });
  });
});
