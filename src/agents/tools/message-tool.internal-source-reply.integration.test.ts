// Integration coverage for real cron message authority and targetless WebChat
// replies through the internal source-reply sink and embedded-run payload projection.
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import * as sessionTranscript from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentRestartRecoveryContext } from "../../gateway/agent-turn/agent-restart-recovery-context.js";
import { persistInternalSourceReply } from "../../gateway/internal-source-reply-persistence.js";
import {
  cleanupManagedOutgoingMediaRecords,
  resolveManagedOutgoingMediaArtifactDownload,
} from "../../gateway/managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import { buildRestartSafeChatTranscriptState } from "../../gateway/server-methods/chat-restart-recovery.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { createRemoteShellSandboxFsBridge } from "../sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createMessageTool } from "./message-tool-execution.js";
import { withCronMessageRun } from "./message-tool.cron.test-support.js";

// Internal WebChat sends have no external channels to discover.
const INTERNAL_SOURCE_CATALOG = {
  version: 0,
  channels: [],
  getChannel: () => undefined,
} as const;

type ToolOptions = NonNullable<Parameters<typeof createMessageTool>[0]>;
function createCurrentSourceMessageTool(params: ToolOptions = {}) {
  const options: ToolOptions = {
    config: { agents: { entries: { main: {} } } },
    preparedMessageToolCatalog: INTERNAL_SOURCE_CATALOG,
    currentChannelProvider: "webchat",
    sourceReplyDeliveryMode: "automatic",
    agentSessionKey: "agent:main:webchat:dm:dashboard",
    runId: "webchat-run",
    sandboxRoot: params.sandboxFsBridge ? params.workspaceDir : undefined,
    ...params,
  };
  setRuntimeConfigSnapshot(options.config ?? {});
  return createMessageTool(options);
}

function withSourceState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "internal-source-reply-" }, run);
}

function sessionScope(state: OpenClawTestState, sessionKey: string, sessionId: string) {
  return {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
}

async function assistantMessages(scope: Parameters<typeof loadTranscriptEvents>[0]) {
  return (await loadTranscriptEvents(scope))
    .map(readTranscriptEventMessage)
    .filter((message) => message?.role === "assistant");
}

async function createSourceSession(state: OpenClawTestState) {
  const scope = sessionScope(state, "agent:main:webchat:dm:source", "source-session");
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    tools: { allow: ["message"] },
  };
  setRuntimeConfigSnapshot(config);
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return {
    state,
    scope,
    config,
    tool: (options: ToolOptions = {}) =>
      createCurrentSourceMessageTool({
        config,
        workspaceDir: state.workspaceDir,
        agentId: scope.agentId,
        agentSessionKey: scope.sessionKey,
        runSessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        ...options,
      }),
    assistants: () => assistantMessages(scope),
    records: () =>
      listManagedImageRecordEntries({ stateDir: state.stateDir, sessionKey: scope.sessionKey }),
  };
}
type SourceSession = Awaited<ReturnType<typeof createSourceSession>>;
function withSourceSession(run: (fixture: SourceSession) => Promise<void>) {
  return withSourceState(async (state) => run(await createSourceSession(state)));
}
function withCronSource(
  run: (
    fixture: SourceSession,
    tool: ReturnType<typeof createMessageTool>,
    owner: Parameters<Parameters<typeof withCronMessageRun>[1]>[0],
  ) => Promise<void>,
) {
  return withSourceSession(async (fixture) =>
    withCronMessageRun(
      {
        cfg: fixture.config,
        storePath: fixture.state.statePath("cron", "source.json"),
        sessionKey: fixture.scope.sessionKey,
        sessionId: fixture.scope.sessionId,
      },
      async (owner) =>
        run(
          fixture,
          owner.createTool({
            preparedMessageToolCatalog: INTERNAL_SOURCE_CATALOG,
            currentChannelProvider: "webchat",
            sourceReplyDeliveryMode: "automatic",
          }),
          owner,
        ),
    ),
  );
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("WebChat message tool internal source reply", () => {
  it.each([
    { sessionKey: "agent:main:dashboard:recovered-cli", delivers: true },
    { sessionKey: "agent:main:webchat:dm:recovered-cli", delivers: true },
    { sessionKey: "agent:main:telegram:direct:123", delivers: false },
  ])(
    "keeps targetless recovered CLI progress internal for $sessionKey",
    async ({ sessionKey, delivers }) => {
      await withSourceState(async (state) => {
        const sessionId = "recovered-cli-session";
        const runId = "recovery-run";
        const scope = sessionScope(state, sessionKey, sessionId);
        const { sessionLifecyclePatch } = buildRestartSafeChatTranscriptState({
          admission: { requestFingerprint: "cli-chat-request" },
          clientRunId: "interrupted-cli-run",
          startedAt: 1,
          sourceIngress: "internal",
        });
        const entry = {
          ...sessionLifecyclePatch,
          sessionId,
          updatedAt: 2,
          restartRecoveryDeliveryRunId: runId,
        };
        await replaceSessionEntry(scope, entry);
        const recovery = resolveAgentRestartRecoveryContext({
          isRestartRecoveryResumeRun: true,
          canUseInternalRuntimeHandoff: true,
          expectedExistingSessionId: sessionId,
          resolvedSessionId: sessionId,
          resolvedSessionKey: sessionKey,
          runId,
          sessionEntry: entry,
        });
        expect(recovery?.pinnedWidgetAuthoring).toBeUndefined();
        const tool = createCurrentSourceMessageTool({
          agentSessionKey: sessionKey,
          runSessionKey: sessionKey,
          sessionId,
          agentId: "main",
          runId,
          currentChannelProvider: recovery?.messageChannel,
        });
        const send = tool.execute("recovered-progress", {
          action: "send",
          message: "Still working after restart.",
          final: false,
        });
        if (!delivers) {
          await expect(send).rejects.toThrow("Action send requires a target.");
          expect(await loadTranscriptEvents(scope)).toEqual([]);
          return;
        }
        const result = await send;
        expect(result.details).toMatchObject({
          sourceReplySink: "internal-ui",
          sourceReplyTranscriptOwner: true,
        });
        const assistants = await assistantMessages(scope);
        expect(assistants).toHaveLength(1);
        expect(assistants[0]?.content).toEqual([
          { type: "text", text: "Still working after restart." },
        ]);
        expect(assistants[0]).toMatchObject({
          __openclaw: { runId },
          openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false },
        });
      });
    },
  );

  it("refuses an internal-source transcript commit after its real cron admission closes", async () =>
    withCronSource(async ({ assistants }, tool, owner) => {
      let commitRequests = 0;
      const admission = probe.admission(operationAdmission, (request, grant, admit) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          isRecord(request.facts.publication) &&
          request.facts.publication.kind === "session-entry-patch-committed"
        ) {
          commitRequests += 1;
          owner.closeAdmission();
        }
        admit(request, grant);
      });
      try {
        const outcome = await tool
          .execute("cron-source-commit", {
            action: "send",
            message: "must never become a committed assistant message",
          })
          .then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
        expect({ commitRequests, assistants: await assistants() }).toEqual({
          commitRequests: 1,
          assistants: [],
        });
        expect(outcome).toHaveProperty("error");
      } finally {
        admission.mockRestore();
      }
    }));

  it("downloads and persists scheduled current-source media once", async () =>
    withCronSource(async ({ assistants }, tool) => {
      const fetchStarted = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const fetch = vi.fn(() => {
        fetchStarted.resolve();
        return response.promise;
      });
      vi.stubGlobal("fetch", fetch);
      let execution: ReturnType<typeof tool.execute> | undefined;
      const respond = () =>
        response.resolve(
          new Response(new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")), {
            headers: { "content-type": "image/png" },
          }),
        );
      try {
        const args = {
          action: "send",
          message: "Remote media from a scheduled current-source reply.",
          media: "https://93.184.216.34/proof.png",
        };
        execution = tool.execute("cron-source-media", args);
        await Promise.race([
          fetchStarted.promise,
          execution.then(() => {
            throw new Error("Scheduled source reply completed before its media request");
          }),
        ]);
        respond();
        expect((await execution).details).toMatchObject({
          sourceReplySink: "internal-ui",
          sourceReplyTranscriptOwner: true,
        });
        await tool.execute("cron-source-media", args);
        const messages = await assistants();
        expect(messages).toHaveLength(1);
        expect(readAssistantDisplayContent(messages[0])).toEqual([
          { type: "text", text: args.message },
          expect.objectContaining({
            type: "image",
            artifactId: expect.stringMatching(/^artifact_managed_image_/u),
          }),
        ]);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        respond();
        await execution?.catch(() => undefined);
        vi.unstubAllGlobals();
      }
    }));

  it.each([true, false])(
    "projects a targetless send and preserves automatic final text only for progress (final=%s)",
    async (final) => {
      const tool = createCurrentSourceMessageTool();

      const toolResult = await tool.execute("message-call", {
        action: "send",
        message: "Visible progress from the message tool.",
        final,
      });
      const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
      const delivery = readEmbeddedMessageDeliveryFact(
        asOptionalRecord(toolResult.details)?.messageDelivery,
      );
      expect(delivery?.sourceReplyDelivered === true).toBe(final);

      const embeddedPayloads = buildEmbeddedRunPayloads({
        assistantTexts: ["Visible automatic final reply."],
        lastAssistant: undefined,
        currentAssistant: undefined,
        sessionKey: "agent:main:webchat:dm:dashboard",
        sourceReplyDeliveryMode: "automatic",
        didDeliverSourceReplyViaMessageTool: delivery?.sourceReplyDelivered,
        messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
        runId: "webchat-run",
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "plain",
      });
      const { replyPayloads: payloads } = await buildReplyPayloads({
        payloads: embeddedPayloads,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "off",
        messagingToolSentTexts: ["Visible progress from the message tool."],
      });

      expect(payloads.map((payload) => payload.text)).toEqual(
        final
          ? ["Visible progress from the message tool."]
          : ["Visible progress from the message tool.", "Visible automatic final reply."],
      );
      expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:webchat:dm:dashboard",
          text: "Visible progress from the message tool.",
          idempotencyKey: "webchat-run:internal-source-reply:0",
        },
      });
      if (!final) {
        expect(getReplyPayloadMetadata(payloads[1] as object)?.sourceReplyTranscriptMirror).toBe(
          undefined,
        );
      }
    },
  );

  it("reports a route-less inter-session send as a transcript record, not a channel delivery", async () => {
    const tool = createCurrentSourceMessageTool({
      agentSessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "message_tool_only",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "sessions_send",
      },
    });

    const toolResult = await tool.execute("message-call", {
      action: "send",
      message: "Child task finished.",
    });

    expect(toolResult.details).toMatchObject({
      target: "current-run",
      sourceReplySink: "internal-ui",
    });
    expect(toolResult.content).toEqual([
      {
        type: "text",
        text: "Recorded reply in the current session transcript via internal-ui. This send did not deliver it to an external channel.",
      },
    ]);
  });

  it.each(["buffer", "workspace"] as const)(
    "stages trusted HTML from %s, persisting only a session-bound send",
    async (source) =>
      withSourceSession(async (f) => {
        const filename = "implementation-plan.html";
        const report = path.join(f.state.workspaceDir, filename);
        const bytes = Buffer.from("<!doctype html><title>Plan</title><h1>Parent revision</h1>");
        if (source === "workspace") {
          await replaceSessionEntry(f.scope, {
            sessionId: f.scope.sessionId,
            chatType: "direct",
            updatedAt: 1,
          });
          await fs.writeFile(report, "<!doctype html><h1>Child draft</h1>");
          await fs.writeFile(report, bytes);
          const automatic = await createReplyMediaPathNormalizer({
            cfg: f.config,
            sessionKey: f.scope.sessionKey,
            workspaceDir: f.state.workspaceDir,
          })({ mediaUrl: report });
          expect(automatic.mediaUrl).toBeUndefined();
          expect(getReplyPayloadMetadata(automatic)?.assistantMediaFailures).toEqual([
            expect.objectContaining({ code: "unsupported-format" }),
          ]);
        }
        const tool =
          source === "buffer"
            ? createCurrentSourceMessageTool({ workspaceDir: f.state.workspaceDir })
            : f.tool();
        const result = await tool.execute("publish-html", {
          action: "send",
          message: "Attached proof.",
          ...(source === "buffer"
            ? { buffer: bytes.toString("base64"), filename, contentType: "text/html" }
            : { media: report }),
        });
        const reply = extractMessagingToolSourceReplyPayload(result);
        expect(reply?.text).toBe("Attached proof.");
        expect(reply?.mediaUrls).toHaveLength(1);
        expect(reply?.attachments).toEqual([
          expect.objectContaining({
            name: filename,
            mimeType: "text/html",
            trustedLocalMedia: true,
          }),
        ]);
        if (source === "workspace") {
          await fs.rm(report);
        } else {
          await expect(fs.readFile(reply?.mediaUrls?.[0] as string)).resolves.toEqual(bytes);
          return;
        }
        const assistants = await f.assistants();
        expect(assistants).toHaveLength(1);
        const display = readAssistantDisplayContent(assistants[0]);
        const attachment = display.find((block) => block.type === "attachment");
        expect(attachment).toMatchObject({
          type: "attachment",
          attachment: { label: filename, mimeType: "text/html" },
        });
        expect(display.some((block) => block.type === "attachment_error")).toBe(false);
        const artifactId = asOptionalRecord(attachment?.attachment)?.artifactId;
        expect(artifactId).toEqual(expect.any(String));
        await expect(
          resolveManagedOutgoingMediaArtifactDownload({
            ...f.scope,
            artifactId: String(artifactId),
            stateDir: f.state.stateDir,
          }),
        ).resolves.toMatchObject({ type: "file", title: filename });
        const records = await f.records();
        expect(records).toHaveLength(1);
        const original = records[0]!.record.original;
        await expect(
          fs.readFile(path.join(original.mediaRoot, original.mediaSubdir, original.mediaId)),
        ).resolves.toEqual(bytes);
      }),
  );

  it("reports a missing workspace file without exposing the draft", async () =>
    withSourceState(async (state) => {
      const media = path.join(state.workspaceDir, "missing.txt");
      const tool = createCurrentSourceMessageTool({ workspaceDir: state.workspaceDir });

      await expect(
        tool.execute("message-path-error", {
          action: "send",
          message: "Private draft that must not enter the error.",
          attachments: [{ media, type: "file", name: "missing.txt" }],
          final: true,
        }),
      ).rejects.toThrow(
        new Error(
          "Current-source media could not be staged.\n⚠️ missing.txt: File not found. Check the path and try again.",
        ),
      );
    }));

  it("uses policy-scoped bridge access for remote-only current-source media", async () =>
    withSourceState(async (state) => {
      const remoteWorkspaceDir = state.path("remote-workspace");
      await fs.mkdir(remoteWorkspaceDir, { recursive: true });
      const html = "<!doctype html><h1>Remote proof</h1>";
      await fs.writeFile(path.join(remoteWorkspaceDir, "proof.html"), html);
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "test",
          workspaceDir: state.workspaceDir,
          agentWorkspaceDir: state.workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });
      const sandboxFsBridge = createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir,
          remoteAgentWorkspaceDir: remoteWorkspaceDir,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      const bridgeReadFile = vi.spyOn(sandboxFsBridge, "readFile");
      const tool = createCurrentSourceMessageTool({
        workspaceDir: state.workspaceDir,
        sandboxContainerWorkdir: "/sandbox",
        sandboxFsBridge,
        sandboxWorkspaceMediaReadAllowed: true,
      });

      const toolResult = await tool.execute("message-remote-media-call", {
        action: "send",
        message: "Attached proof.",
        media: "/sandbox/proof.html",
      });

      const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
      expect(sourceReply?.mediaUrls).toHaveLength(1);
      await expect(fs.readFile(sourceReply?.mediaUrls?.[0] as string, "utf8")).resolves.toBe(html);

      bridgeReadFile.mockClear();
      const deniedTool = createCurrentSourceMessageTool({
        workspaceDir: state.workspaceDir,
        sandboxContainerWorkdir: "/sandbox",
        sandboxFsBridge,
        sandboxWorkspaceMediaReadAllowed: false,
      });
      await expect(
        deniedTool.execute("message-remote-media-denied", {
          action: "send",
          message: "Attached proof.",
          media: "/sandbox/proof.html",
        }),
      ).rejects.toThrow(/could not be staged|outside workspace root/i);
      expect(bridgeReadFile).not.toHaveBeenCalled();
    }));

  it("publishes managed media with aligned metadata and the current run owner", async () =>
    withSourceSession(async (f) => {
      const { state, scope } = f;
      const { stateDir, workspaceDir } = state;
      const { sessionKey, sessionId } = scope;
      const imagePaths = ["first.png", "second.png"].map((name) => path.join(workspaceDir, name));
      const documentPath = path.join(workspaceDir, "report.json");
      const documentName = "Quarterly report.json";
      await Promise.all(
        imagePaths.map((imagePath) =>
          fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64")),
        ),
      );
      await fs.writeFile(documentPath, '{"status":"ready"}\n');
      await replaceSessionEntry(scope, { sessionId, chatType: "direct", updatedAt: 1 });

      const tool = f.tool({ sourceReplyDeliveryMode: undefined });

      const sendParams = {
        action: "send" as const,
        message: "Durable image reply",
        mediaUrls: [...imagePaths, documentPath],
        attachments: [{ media: documentPath, name: documentName, mimeType: "application/json" }],
      };
      const updates: SessionTranscriptUpdate[] = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        updates.push(update);
      });
      const append = sessionTranscript.appendAssistantMessageToSessionTranscript;
      let preCommitEntries: Awaited<ReturnType<typeof listManagedImageRecordEntries>> = [];
      const appendSpy = vi
        .spyOn(sessionTranscript, "appendAssistantMessageToSessionTranscript")
        .mockImplementationOnce(async (params) => {
          await cleanupManagedOutgoingMediaRecords({ stateDir });
          preCommitEntries = await f.records();
          for (const { record } of preCommitEntries) {
            const { mediaRoot, mediaSubdir, mediaId, contentType } = record.original;
            expect(await fs.readFile(path.join(mediaRoot, mediaSubdir, mediaId))).toEqual(
              contentType === "image/png"
                ? Buffer.from(TINY_PNG_BASE64, "base64")
                : Buffer.from('{"status":"ready"}\n'),
            );
          }
          return append(params);
        });
      const [toolResult, overlappingResult] = await Promise.all([
        tool.execute("restart-proof-call", sendParams),
        tool.execute("restart-proof-call", sendParams),
      ]).finally(() => {
        unsubscribe();
        appendSpy.mockRestore();
      });
      expect(preCommitEntries).toHaveLength(3);
      const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
      expect(overlappingResult.details).toMatchObject({
        idempotencyKey: sourceReply?.idempotencyKey,
        sourceReplyTranscriptOwner: true,
      });
      const sourcePayloads = buildEmbeddedRunPayloads({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAssistant: undefined,
        sessionKey,
        agentId: "main",
        sourceReplyDeliveryMode: "message_tool_only",
        messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
        runId: "webchat-run",
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "plain",
      });
      expect(sourcePayloads[0]).toMatchObject({
        attachments: [
          expect.objectContaining({ name: "first.png", trustedLocalMedia: true }),
          expect.objectContaining({ name: "second.png", trustedLocalMedia: true }),
          expect.objectContaining({
            name: documentName,
            mimeType: "application/json",
            trustedLocalMedia: true,
          }),
        ],
        trustedLocalMedia: true,
      });
      const mirror = getReplyPayloadMetadata(
        sourcePayloads[0] as object,
      )?.sourceReplyTranscriptMirror;
      expect(mirror).toMatchObject({ transcriptOwner: true });
      const assistants = await f.assistants();
      expect(assistants).toHaveLength(1);
      const assistant = assistants[0];
      const displayContent = readAssistantDisplayContent(assistant);
      const image = displayContent.find((block) => block.type === "image");
      const document = displayContent.find((block) => block.type === "attachment");
      expect(assistant?.content).toEqual([{ type: "text", text: "Durable image reply" }]);
      expect(image).toMatchObject({
        type: "image",
        artifactId: expect.stringMatching(/^artifact_managed_image_/u),
      });
      expect(displayContent.filter((block) => block.type === "image")).toHaveLength(2);
      expect(document).toMatchObject({
        type: "attachment",
        attachment: {
          artifactId: expect.stringMatching(/^artifact_managed_media_/u),
          kind: "document",
          label: documentName,
          mimeType: "application/json",
        },
      });
      expect(JSON.stringify(assistant)).not.toContain(workspaceDir);
      expect(await f.records()).toHaveLength(3);
      const published = updates.find(
        (update) =>
          update.runId === "webchat-run" && asOptionalRecord(update.message)?.role === "assistant",
      );
      expect(published).toMatchObject({
        runId: "webchat-run",
        target: { agentId: "main", sessionId, sessionKey },
      });
      expect(asOptionalRecord(published?.message)?.content).toEqual(assistant?.content);
      expect(asOptionalRecord(published?.message)?.openclawDisplayContent).toEqual(displayContent);
    }));

  it("cleans uncommitted source-reply originals when another writer wins", async () =>
    withSourceSession(async ({ state, scope, config: cfg, records }) => {
      const { sessionKey, sessionId } = scope;
      const imagePath = path.join(state.workspaceDir, "proof.png");
      await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
      const append = sessionTranscript.appendAssistantMessageToSessionTranscript;
      const preparedOriginals: string[] = [];
      const appendSpy = vi
        .spyOn(sessionTranscript, "appendAssistantMessageToSessionTranscript")
        .mockImplementationOnce(async (params) => {
          for (const {
            record: { original },
          } of await records()) {
            preparedOriginals.push(
              path.join(original.mediaRoot, original.mediaSubdir, original.mediaId),
            );
          }
          // Another writer wins after the source-reply owner's initial lookup.
          await append({
            ...params,
            eventId: "winning-message",
            content: [{ type: "text", text: "Already delivered" }],
            onMessageCommitted: undefined,
          });
          return append(params);
        });
      try {
        await expect(
          persistInternalSourceReply({
            cfg,
            sessionKey,
            expectedSessionId: sessionId,
            agentId: "main",
            idempotencyKey: "append-outcome-reply",
            sourceReplyFinal: true,
            payload: { text: "Attached proof", mediaUrls: [imagePath], trustedLocalMedia: true },
          }),
        ).rejects.toThrow("conflicts with the admitted message");
      } finally {
        appendSpy.mockRestore();
      }
      expect(preparedOriginals).toHaveLength(1);
      expect(await listManagedImageRecordEntries({ stateDir: state.stateDir, sessionKey })).toEqual(
        [],
      );
      await expect(fs.stat(preparedOriginals[0]!)).rejects.toMatchObject({ code: "ENOENT" });
      const assistants = (await loadTranscriptEvents(scope)).filter(
        (event) => readTranscriptEventMessage(event)?.role === "assistant",
      );
      expect(assistants).toEqual([
        expect.objectContaining({
          id: "winning-message",
          message: expect.objectContaining({
            content: [{ type: "text", text: "Already delivered" }],
          }),
        }),
      ]);
    }));
});
