import "../config/sessions/session-entry-patch-delivery.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { getSession, waitForExecScope } from "../agents/bash-process-registry.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import {
  fullGatewayExec,
  nodeCommand,
  runningSession,
} from "../agents/bash-tools.lifecycle.test-support.js";
import { createProcessTool } from "../agents/bash-tools.process.js";
import { truncateOversizedToolResultsInSessionManager } from "../agents/embedded-agent-runner/tool-result-truncation.js";
import { acknowledgeInternalToolResult } from "../agents/runtime/internal-hooks.js";
import * as sandboxContext from "../agents/sandbox/context.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { performSessionGitHubPreparation } from "./github-pr-workspace-preparation.js";
import * as availability from "./github-publication-availability.js";
import * as baseRefresh from "./github-publication-base-refresh.js";
import * as inspect from "./github-publication-inspect.js";
import * as preflight from "./github-publication-pr-preflight.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { SESSION_READ_SCOPE, SESSION_WRITE_SCOPE } from "./operator-scopes.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  createOperatorWsClient,
  dispatchProfile,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { adoptUnboundPullRequestWorkspace } from "./session-pr-workspace-adoption.js";
import * as allocation from "./session-worktree-preparation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");

async function requestSessionFile(
  context: ReturnType<typeof createDirectChatContext>,
  sessionKey: string,
  params: Record<string, unknown>,
  client: GatewayClient | null = null,
  operation: "get" | "set" | "assets" = "get",
) {
  const method = `sessions.files.${operation}`;
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: method,
      method,
      params: { sessionKey, path: "notes.md", ...params },
    },
    client,
    context,
    respond,
    isWebchatConnect: () => false,
    extraHandlers: sessionsFilesHandlers,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]!;
}

function createAdoptionFixture(workspaceDir: string, sessionId: string) {
  const cfg = { agents: { entries: { main: { workspace: workspaceDir } } } };
  setRuntimeConfigSnapshot(cfg);
  const target = {
    agentId: "main",
    sessionKey: `agent:main:${sessionId}`,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  return { cfg, target, scope: { ...target, sessionId } };
}

async function createConversation(
  workspaceDir: string,
  sessionId: string,
  entry: Partial<InternalSessionEntry> = {},
) {
  const fixture = createAdoptionFixture(workspaceDir, sessionId);
  await upsertSessionEntryCore(fixture.target, {
    sessionId,
    updatedAt: 1,
    sessionRoot: workspaceDir,
    ...entry,
  });
  const manager = await SessionManager.openAsync(fixture.scope, workspaceDir);
  const createContext = () => createDirectChatContext({ getRuntimeConfig: () => fixture.cfg });
  const createSandbox = () =>
    createSandboxTestContext({
      overrides: {
        sessionKey: fixture.target.sessionKey,
        workspaceDir,
        workspaceSource: undefined,
      },
    });
  const adopt = (
    context: ReturnType<typeof createContext>,
    sandbox: ReturnType<typeof createSandbox>,
  ) =>
    adoptUnboundPullRequestWorkspace({
      context,
      target: fixture.target,
      sandbox,
      entry: loadSessionEntryReadOnly(fixture.target)!,
      assertCurrent() {},
      async verifyBeforeBinding() {},
    });
  return { ...fixture, manager, createContext, createSandbox, adopt };
}

function expectOriginalFile(
  result: Awaited<ReturnType<typeof requestSessionFile>>,
  content: string,
) {
  expect(result).toMatchObject([true, { file: { content } }]);
  expect(result[1].file.hash).toBeUndefined();
  expect(result[1].source).toBeUndefined();
}

function createManagedSandbox(sessionKey: string, workspaceDir: string) {
  return {
    ...createSandboxTestContext({
      overrides: { sessionKey, workspaceDir, workspaceSource: "managed-worktree" },
    }),
    [Symbol.dispose]() {},
  };
}

it("adopts one empty owner and keeps original message files separate from same-name current files", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    // A guest's first turn records its selected skill libraries before adoption.
    const entry = {
      sessionId: "adopt",
      updatedAt: 1,
      sessionRoot: state.workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [],
        librarySelections: [
          {
            skillId: "11111111-1111-4111-8111-111111111111",
            revision: "a".repeat(64),
            name: "notes",
            ownerProfileId: "adopt-owner",
          },
        ],
      },
    };
    const {
      cfg,
      target,
      scope,
      manager,
      createContext,
      createSandbox,
      adopt: adoptWorkspace,
    } = await createConversation(state.workspaceDir, "adopt", entry);
    const sibling = { ...target, sessionKey: "agent:main:sibling" };
    await upsertSessionEntryCore(sibling, { ...entry, sessionId: "sibling" });
    const siblingBefore = loadSessionEntryReadOnly(sibling);
    const oldMessage = await manager.appendMessageAsync(makeUserMessage("Open notes.md", 1));
    const boundaryMessage = await manager.appendMessageAsync(makeUserMessage("Prepare my PR", 2));
    assert(oldMessage && boundaryMessage, "Original transcript messages must be persisted");
    await fs.writeFile(path.join(state.workspaceDir, "notes.md"), "same original bytes\n");
    const context = createContext();
    const request = async (
      operation: "get" | "set" | "assets",
      params: Record<string, unknown> = {},
    ) => requestSessionFile(context, target.sessionKey, params, null, operation);
    const before = await request("get");
    expect(before[0]).toBe(true);
    const oldHash = before[1].file.hash;
    const sandbox = createSandbox();
    const adopt = () => adoptWorkspace(context, sandbox);
    const input = {
      context,
      target,
      entry: loadSessionEntryReadOnly(target)!,
      sandbox,
      assertCurrent() {},
      async verifyBeforeBinding() {},
    };
    const beforeUnsupported = loadSessionEntryReadOnly(target);
    await expect(
      adoptUnboundPullRequestWorkspace({
        ...input,
        sandbox: { ...sandbox, backendId: "ssh" },
      }),
    ).rejects.toThrow("require a local Docker or Podman sandbox");
    expect(loadSessionEntryReadOnly(target)).toEqual(beforeUnsupported);
    expect(await managedWorktrees.findLiveByOwner("session", target.sessionKey)).toBeUndefined();
    const exec = createExecTool({
      ...fullGatewayExec,
      config: cfg,
      agentId: "main",
      sessionKey: target.sessionKey,
      scopeKey: target.sessionKey,
      allowBackground: true,
      notifyOnExit: false,
    });
    const background = runningSession(
      (
        await exec.execute("background", {
          command: nodeCommand(
            `require("node:fs").watch(${JSON.stringify(state.workspaceDir)}, () => {})`,
          ),
          background: true,
        })
      ).details,
    );
    const process = createProcessTool({ scopeKey: target.sessionKey });
    try {
      await expect(adoptUnboundPullRequestWorkspace(input)).rejects.toThrow("background work");
      expect(getSession(background.sessionId)?.exited).toBe(false);
      expect(loadSessionEntryReadOnly(target)?.worktree).toBeUndefined();
    } finally {
      await process.execute("stop-fixture", { action: "kill", sessionId: background.sessionId });
      await waitForExecScope(target.sessionKey);
      acknowledgeInternalToolResult(
        await process.execute("observe-fixture", {
          action: "poll",
          sessionId: background.sessionId,
        }),
      );
    }
    const allocate = allocation.prepareSessionWorktree;
    let queued: ReturnType<typeof reserveSessionControllerSource> | undefined;
    const duringPreparation = vi
      .spyOn(allocation, "prepareSessionWorktree")
      .mockImplementationOnce(async (...args) => {
        const result = await allocate(...args);
        queued = reserveSessionControllerSource(target.sessionKey, {
          policy: { mode: "followup" },
          target: captureSessionTarget({
            storeScope: target.storePath,
            sessionKey: target.sessionKey,
            agentId: target.agentId,
            incarnation: entry.sessionId,
          }),
        });
        return result;
      });
    try {
      await expect(adoptUnboundPullRequestWorkspace(input)).rejects.toThrow("queued input");
      expect(loadSessionEntryReadOnly(target)?.worktree).toBeUndefined();
      expect(await managedWorktrees.findLiveByOwner("session", target.sessionKey)).toBeUndefined();
    } finally {
      duringPreparation.mockRestore();
      if (queued) {
        retireSessionControllerInput(queued);
        await queued.settlement.promise;
      }
    }
    let committing: admission.SqliteWorkerOperationAdmission | undefined;
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    const captureAdmission = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) => {
        const owned = createAdmission((admissionRequest, grant) => {
          if (admissionRequest.stage === "commit") {
            committing = owned;
          }
          callback(admissionRequest, grant);
        }, attachment);
        return owned;
      });
    const restoreSettlement: Array<() => void> = [];
    const lostCommit = vi.fn(() => {
      expect(committing?.committed?.facts).toMatchObject({
        kind: "session-entry-patch-committed",
      });
      if (!committing) {
        throw new Error("Workspace binding did not reach native commit admission");
      }
      const settlement = vi
        .spyOn(committing, "settlement", "get")
        .mockReturnValue({ kind: "unknown" });
      restoreSettlement.push(() => settlement.mockRestore());
      throw new Error("Lost source-commit acknowledgement");
    });
    getSessionEntryPatchDelivery().afterCommit = lostCommit;
    try {
      await expect(adoptUnboundPullRequestWorkspace(input)).rejects.toMatchObject({
        code: "outcome-unknown",
      });
      expect(loadSessionEntryReadOnly(target)?.worktree?.id).toBeDefined();
    } finally {
      getSessionEntryPatchDelivery().afterCommit = undefined;
      restoreSettlement.forEach((restore) => restore());
      captureAdmission.mockRestore();
    }
    const adopted = await adopt();
    const worktree = await managedWorktrees.findLiveByOwner("session", target.sessionKey);
    expect(worktree).toBeDefined();
    try {
      expect(adopted.sessionId).toBe(entry.sessionId);
      expect(projectPublicSessionEntry(adopted)).not.toHaveProperty("priorWorkspace");
      expect(adopted.priorWorkspace).toMatchObject({
        sessionId: "adopt",
        fileRoot: state.workspaceDir,
      });
      expect(await fs.readdir(worktree!.path)).toEqual([".git"]);
      await fs.writeFile(path.join(worktree!.path, "notes.md"), "same original bytes\n");
      const nextMessage = await manager.appendMessageAsync(
        makeUserMessage("Open the new notes.md", 2),
      );
      assert(nextMessage, "Current-source message must be persisted");
      for (const expectedSource of [
        undefined,
        { workspaceId: "another-workspace", root: worktree!.path, fileRoot: worktree!.path },
      ]) {
        const rejected = await request("set", {
          content: "stale draft",
          expectedHash: oldHash,
          ...(expectedSource ? { expectedSource } : {}),
        });
        expect(rejected[0]).toBe(false);
        expect(rejected[2]).toMatchObject({ details: { type: "session_file_source_changed" } });
      }
      expect(await fs.readFile(path.join(worktree!.path, "notes.md"), "utf8")).toBe(
        "same original bytes\n",
      );
      const current = await request("get", { messageEntryId: nextMessage });
      expect(current[0]).toBe(true);
      expect(current[1]).toMatchObject({
        source: { workspaceId: worktree!.id },
        file: { hash: oldHash },
      });
      const saved = await request("set", {
        content: "current source edit\n",
        expectedHash: oldHash,
        expectedSource: current[1].source,
      });
      expect(saved[0]).toBe(true);
      const historical = await request("get", { messageEntryId: oldMessage });
      expectOriginalFile(historical, "same original bytes\n");
      const assistant = makeAssistantMessageFixture({
        stopReason: "stop",
        content: [{ type: "text", text: "Imported the PR" }],
      });
      const assistantId = await manager.appendMessageAsync(assistant);
      assert(assistantId, "Assistant rewrite target must be persisted");
      const beforeRewrite = await readSessionTranscriptAnchorsAsync(scope, {
        entryIds: [assistantId],
        includeWatermark: true,
      });
      await rewritePreparedTranscriptMessageAtAnchor(beforeRewrite.anchors[0]!, () => ({
        ...assistant,
        content: [{ type: "text" as const, text: "Imported the PR with an attachment" }],
      }));
      expectOriginalFile(
        await request("get", { messageEntryId: oldMessage }),
        "same original bytes\n",
      );
      expect((await request("get", { messageEntryId: nextMessage }))[1].file.content).toBe(
        "current source edit\n",
      );
      const refreshed = await SessionManager.openAsync(scope, state.workspaceDir);
      expect(
        await refreshed.removeTrailingEntriesAsync((message) => message.id === boundaryMessage, {
          preserveTrailing: (message) => message.id === nextMessage || message.id === assistantId,
        }),
      ).toBe(1);
      expectOriginalFile(
        await request("get", { messageEntryId: oldMessage }),
        "same original bytes\n",
      );
      expect((await request("get", { messageEntryId: nextMessage }))[0]).toBe(false);
      await refreshed.branchAsync(assistantId);
      await refreshed.appendMessageAsync(makeUserMessage("Continue the retained PR branch", 3));
      await waitForSessionTranscriptProjection(scope);
      const originalAfterBranch = await request("get", { messageEntryId: oldMessage });
      expectOriginalFile(originalAfterBranch, "same original bytes\n");
      const currentAfterBranch = await request("get", { messageEntryId: nextMessage });
      expect(currentAfterBranch).toMatchObject([
        true,
        { file: { content: "current source edit\n" } },
      ]);
      expect((await request("get", { messageEntryId: boundaryMessage }))[0]).toBe(false);
      expect((await request("get", { messageEntryId: "forged-message" }))[0]).toBe(false);
      await fs.writeFile(
        path.join(state.workspaceDir, "index.html"),
        '<link rel="stylesheet" href="style.css">',
      );
      await fs.writeFile(path.join(state.workspaceDir, "style.css"), "body { color: blue; }");
      await fs.writeFile(path.join(worktree!.path, "style.css"), "body { color: red; }");
      const assets = await request("assets", {
        path: "index.html",
        refs: ["style.css"],
        messageEntryId: oldMessage,
      });
      expect(assets[0]).toBe(true);
      expect(Buffer.from(assets[1].assets[0].content, "base64").toString()).toBe(
        "body { color: blue; }",
      );
      const repeated = await adopt();
      expect(repeated.worktree?.id).toBe(worktree!.id);
      expect(await fs.readFile(path.join(worktree!.path, "notes.md"), "utf8")).toBe(
        "current source edit\n",
      );
      expect(await fs.readFile(path.join(state.workspaceDir, "notes.md"), "utf8")).toBe(
        "same original bytes\n",
      );
      expect(loadSessionEntryReadOnly(sibling)).toEqual(siblingBefore);
    } finally {
      if (worktree) {
        await removeWorktree(worktree.id);
      }
    }
  });
});

it("keeps earlier message files original after a maintenance rewrite re-appends them", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { target, scope, manager, createContext, createSandbox, adopt } =
      await createConversation(state.workspaceDir, "adopt-rewrite");
    await manager.appendMessageAsync(makeUserMessage("Write notes.md", 1));
    await manager.appendMessageAsync(
      makeAssistantMessageFixture({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "call-notes", name: "write", arguments: { path: "notes.md" } },
        ],
      }),
    );
    // An oversized pre-switch result makes recovery rewrite from inside the original prefix.
    await manager.appendMessageAsync(
      makeTextToolResult("call-notes", "write", "x".repeat(40_000), false, 2),
    );
    const earlier = await manager.appendMessageAsync(
      makeAssistantMessageFixture({
        stopReason: "stop",
        content: [{ type: "text", text: "Saved notes.md" }],
      }),
    );
    assert(earlier, "The earlier message must be persisted");
    await fs.writeFile(path.join(state.workspaceDir, "notes.md"), "original notes\n");
    const context = createContext();
    await adopt(context, createSandbox());
    const worktree = await managedWorktrees.findLiveByOwner("session", target.sessionKey);
    assert(worktree, "Adoption must bind a managed workspace");
    try {
      await fs.writeFile(path.join(worktree.path, "notes.md"), "PR notes\n");
      await manager.appendMessageAsync(makeUserMessage("Open the PR notes.md", 3));
      const truncated = await truncateOversizedToolResultsInSessionManager({
        sessionManager: await SessionManager.openAsync(scope, state.workspaceDir),
        contextWindowTokens: 1_000,
      });
      expect(truncated).toMatchObject({ truncated: true, truncatedCount: 1 });
      await waitForSessionTranscriptProjection(scope);
      const branch = (await SessionManager.openAsync(scope, state.workspaceDir)).getBranch();
      const copyOf = (text: string) => {
        const entry = branch.find(
          (item) => item.type === "message" && JSON.stringify(item.message).includes(text),
        );
        assert(entry && entry.id !== earlier, `The rewrite must re-append "${text}"`);
        return entry.id;
      };
      // A link rendered before the rewrite names the superseded id; reloading supplies its copy.
      expect(
        await requestSessionFile(context, target.sessionKey, { messageEntryId: earlier }),
      ).toMatchObject([false, undefined, { message: expect.stringContaining("reload") }]);
      const original = await requestSessionFile(context, target.sessionKey, {
        messageEntryId: copyOf("Saved notes.md"),
      });
      expectOriginalFile(original, "original notes\n");
      const current = await requestSessionFile(context, target.sessionKey, {
        messageEntryId: copyOf("Open the PR notes.md"),
      });
      expect(current).toMatchObject([
        true,
        { file: { content: "PR notes\n" }, source: { workspaceId: worktree.id } },
      ]);
      expect(current[1].file.hash).toBeDefined();
    } finally {
      await removeWorktree(worktree.id);
    }
  });
});

const pullRequest = {
  url: "https://github.com/example/repo/pull/1",
  host: "github.com",
  number: 1,
  base: { repository: "example/repo", repositoryId: 1, branch: "main", commit: "b".repeat(40) },
  head: { repository: "guest/repo", repositoryId: 2, branch: "topic", commit: "a".repeat(40) },
};

/** GitHub I/O and the container runtime stay synthetic; the handler, its session read,
 * allocation, binding, file-source checks and the PR association write are real. */
function stubPullRequestPreparation(sessionKey: string) {
  vi.spyOn(inspect, "inspectOwnGitHubPullRequest").mockResolvedValue({
    result: pullRequest,
    assertCurrent() {},
  } as never);
  vi.spyOn(availability, "prepareCurrentGitHubPublicationIdentity").mockResolvedValue({
    account: { accountId: 9 },
  } as never);
  vi.spyOn(availability, "matchesCurrentGitHubPublicationIdentity").mockReturnValue(true);
  vi.spyOn(preflight, "assertExistingPullRequestWriteAccess").mockResolvedValue(undefined);
  const resolveSandbox = vi
    .spyOn(sandboxContext, "resolveSandboxContext")
    .mockImplementation(
      async (params) => createManagedSandbox(sessionKey, params.workspaceDir) as never,
    );
  const integrate = vi
    .spyOn(baseRefresh, "integrateManagedWorkspaceSource")
    .mockImplementation(async (params) => {
      await params.source!.accept();
      return {
        status: "refreshed",
        repository: "guest/repo",
        baseBranch: "main",
        baseCommit: "b".repeat(40),
        changedPaths: ["pr.txt"],
        conflictPaths: [],
        review: { mode: "local", base: "b".repeat(40) },
      };
    });
  return { resolveSandbox, integrate };
}

function createPreparationContext(cfg: OpenClawConfig) {
  return Object.assign(createDirectChatContext({ getRuntimeConfig: () => cfg }), {
    workerSessionPlacementService: {
      withWorkspaceExclusion: async () => {
        throw new Error("An unbound conversation reserves a new local workspace");
      },
      withLocalWorkspaceReservation: async (
        _session: unknown,
        run: (assertOwned: () => void) => Promise<unknown>,
      ) => await run(() => {}),
    },
  });
}

/** The conversation's own sandboxed agent asks for its PR through the registered handler. */
async function preparePullRequest(params: {
  context: ReturnType<typeof createPreparationContext>;
  sessionKey: string;
  sessionId: string;
  workspaceDir: string;
  client: GatewayClient | null;
}) {
  const sandbox = createSandboxTestContext({
    overrides: {
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      workspaceSource: undefined,
      backend: { id: "docker" } as never,
    },
  });
  const respond = vi.fn();
  await withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: params.sessionKey,
      workspaceBaseRefreshSandbox: sandbox,
      workspacePrAdoptionSessionId: params.sessionId,
    },
    () =>
      performSessionGitHubPreparation({
        req: { type: "req", id: "prepare", method: "sessions.github.action" },
        params: {
          sessionKey: params.sessionKey,
          action: "prepare_pr",
          pullRequestUrl: pullRequest.url,
        },
        context: params.context,
        client: params.client,
        isWebchatConnect: () => false,
        respond,
      } as never),
  );
  return respond;
}

async function removeOwnedWorktree(sessionKey: string) {
  const worktree = await managedWorktrees.findLiveByOwner("session", sessionKey);
  if (worktree) {
    await removeWorktree(worktree.id);
  }
}

async function removeWorktree(id: string) {
  await managedWorktrees.remove({ id, reason: "test-cleanup", allowSnapshotLoss: true });
}

it("refuses another guest and lost access before binding, PR import and earlier file reads", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const scopes = [SESSION_READ_SCOPE, SESSION_WRITE_SCOPE];
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              // Team guests can view shared conversations they do not own.
              guest: { sessions: { others: "view" }, agents: ["main"], scopes },
              admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
              revoked: { sessions: { others: "none" }, agents: [], scopes: [] },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const guest = (await ensureCanonicalUserProfileForEmail("adoption-guest@example.test")).id;
      const other = (await ensureCanonicalUserProfileForEmail("adoption-other@example.test")).id;
      const admin = (await ensureCanonicalUserProfileForEmail("adoption-admin@example.test")).id;
      await setCanonicalUserProfileRole(admin, "admin");
      invalidateOperatorRolePolicy(admin);
      const setGuestRole = async (role: "guest" | "revoked") => {
        await setCanonicalUserProfileRole(guest, role);
        invalidateOperatorRolePolicy(guest);
      };
      // Each caller is an authenticated connection; only the creator owns the conversation.
      const connect = (profileId: string, clientScopes: string[] = scopes) => {
        const client = createOperatorWsClient({ connId: profileId, scopes: clientScopes });
        client.authenticatedUserProfile = dispatchProfile(profileId);
        prepareGatewayConnectOperatorAccess(client);
        return client;
      };
      const guestClient = connect(guest);
      const otherClient = connect(other);
      const adminClient = connect(admin, ["operator.admin"]);
      const target = {
        agentId: "main",
        sessionKey: "agent:main:adopt-authority",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const sessionId = "adopt-authority";
      await upsertSessionEntryCore(target, {
        sessionId,
        updatedAt: 1,
        sessionRoot: state.workspaceDir,
        createdActor: { type: "human", source: "profile", id: guest },
      });
      const manager = await SessionManager.openAsync({ ...target, sessionId }, state.workspaceDir);
      const earlier = await manager.appendMessageAsync(makeUserMessage("Open notes.md", 1));
      assert(earlier, "The earlier message must be persisted");
      await fs.writeFile(path.join(state.workspaceDir, "notes.md"), "original notes\n");
      const { resolveSandbox, integrate } = stubPullRequestPreparation(target.sessionKey);
      const context = createPreparationContext(cfg);
      const prepare = (client: GatewayClient) =>
        preparePullRequest({
          context,
          sessionKey: target.sessionKey,
          sessionId,
          workspaceDir: state.workspaceDir,
          client,
        });
      const unbound = () => {
        const entry = loadSessionEntryReadOnly(target);
        expect(entry?.worktree).toBeUndefined();
        expect(entry?.priorWorkspace).toBeUndefined();
      };
      const allocateWorkspace = allocation.prepareSessionWorktree;
      const allocate = vi.spyOn(allocation, "prepareSessionWorktree");
      try {
        // Another guest fails the publication requester; an admin passes it but is not the owner.
        await expect(prepare(otherClient)).rejects.toThrow("no longer authorized");
        await expect(prepare(adminClient)).rejects.toThrow("Only this conversation's owner");
        expect(allocate).not.toHaveBeenCalled();
        unbound();

        // Access lost after allocation is refused before the PR workspace is bound.
        allocate.mockImplementationOnce(async (...args) => {
          const allocated = await allocateWorkspace(...args);
          await setGuestRole("revoked");
          return allocated;
        });
        await expect(prepare(guestClient)).rejects.toThrow("no longer authorized");
        unbound();
        expect(
          await managedWorktrees.findLiveByOwner("session", target.sessionKey),
        ).toBeUndefined();
        await setGuestRole("guest");

        // Access lost after binding is refused before PR source import.
        resolveSandbox.mockImplementationOnce(async (params) => {
          await setGuestRole("revoked");
          return createManagedSandbox(target.sessionKey, params.workspaceDir) as never;
        });
        await expect(prepare(guestClient)).rejects.toThrow("no longer authorized");
        expect(integrate).not.toHaveBeenCalled();
        expect(loadSessionEntryReadOnly(target)?.worktree?.githubPullRequest).toBeUndefined();
        await setGuestRole("guest");

        expect(await prepare(guestClient)).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "prepared", headCommit: "a".repeat(40) }),
        );
        const readEarlier = (client: GatewayClient) =>
          requestSessionFile(context, target.sessionKey, { messageEntryId: earlier }, client);
        expectOriginalFile(await readEarlier(guestClient), "original notes\n");
        // A viewing guest or an admin sees the current files, never the owner's originals.
        const worktree = await managedWorktrees.findLiveByOwner("session", target.sessionKey);
        assert(worktree, "Preparation must bind the PR workspace");
        expect(loadSessionEntryReadOnly(target)).toMatchObject({
          worktree: {
            id: worktree.id,
            githubPullRequest: { number: 1, preparedHeadCommit: "a".repeat(40) },
          },
          priorWorkspace: { fileRoot: state.workspaceDir },
        });
        await fs.writeFile(path.join(worktree.path, "notes.md"), "PR notes\n");
        const refused = [false, undefined];
        for (const client of [otherClient, adminClient]) {
          expect(await requestSessionFile(context, target.sessionKey, {}, client)).toMatchObject([
            true,
            { file: { content: "PR notes\n" } },
          ]);
          expect((await readEarlier(client)).slice(0, 2)).toEqual(refused);
        }
        await setGuestRole("revoked");
        expect((await readEarlier(guestClient)).slice(0, 2)).toEqual(refused);
      } finally {
        await removeOwnedWorktree(target.sessionKey);
      }
    },
  );
});
