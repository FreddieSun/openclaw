import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionsRecoverResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  initializeManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
} from "../agents/worktrees/service.test-support.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import {
  beginSessionEffect,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { recoverGatewaySession } from "./session-recovery-service.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetInWorker,
} from "./session-utils.js";
import { agentCommandMock, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const titleGeneration = vi.hoisted(() =>
  vi.fn<
    typeof import("../auto-reply/reply/conversation-label-generator.js").generateConversationLabelWithFallback
  >(),
);

// Recovery owns identity and continuation; title model behavior has separate boundary coverage.
vi.mock("../auto-reply/reply/conversation-label-generator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/conversation-label-generator.js")>()),
  generateConversationLabelWithFallback: titleGeneration,
}));

// Reverse hook order joins accepted fixture work before draining global owners.
afterEach(() => drainGlobalSingletonLifecycleState());

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const prepareProfiles = useUserProfileCatalogForTest();

beforeEach(async () => {
  await prepareProfiles();
  titleGeneration.mockReset().mockResolvedValue("Recovered session");
});

function recoveryWorkerPlacement<State extends WorkerSessionPlacementRecord["state"]>(params: {
  sessionId: string;
  sessionKey: string;
  state: State;
  generation?: number;
}): Extract<WorkerSessionPlacementRecord, { state: State }> {
  return {
    ...params,
    agentId: "main",
    generation: params.generation ?? 2,
    turnClaim: null,
    environmentId: params.state === "local" || params.state === "requested" ? null : "worker-env",
  } as Extract<WorkerSessionPlacementRecord, { state: State }>;
}

function recoveryPlacementReader(current: () => WorkerSessionPlacementRecord | undefined) {
  return {
    getMany(sessionIds: readonly string[]) {
      const placement = current();
      return new Map(
        placement && sessionIds.includes(placement.sessionId)
          ? [[placement.sessionId, placement]]
          : [],
      );
    },
  };
}

function reclaimBarriers(
  current: () => WorkerSessionPlacementRecord,
  waitForTurnClaimRelease: () => Promise<void> = async () => {},
  loadSessionRuntime = async () => ({
    managedWorktrees,
    resolveCanonicalSessionEntryFromStoreKeys,
    resolveGatewaySessionStoreTargetInWorker,
  }),
) {
  return createGatewayWorkerPlacementReclaimBarriers({
    cancelSessionWork: vi.fn(async () => {}),
    placements: { get: current, getAsync: async () => current(), waitForTurnClaimRelease },
    loadSessionRuntime,
    revokeSessionAuthority: vi.fn(),
  });
}

async function recoveryFixture(
  name: string,
  overrides?: Parameters<typeof sessionStoreEntry>[1],
  messages: Parameters<typeof seedSessionTranscript>[0]["messages"] = [
    { role: "user", content: "recover the interrupted cloud workspace" },
  ],
) {
  const { dir, storePath } = await createSessionStoreDir();
  const sourceKey = `agent:main:dashboard:${name}`;
  const sourceSessionId = `${name}-source`;
  await writeSessionStore({
    entries: {
      [sourceKey]: sessionStoreEntry(sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: `cycle-${sourceSessionId}`,
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
        ...overrides,
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
    messages,
  });
  const scope = { agentId: "main", sessionKey: sourceKey, storePath };
  return {
    dir,
    sourceKey,
    sourceSessionId,
    scope,
    source: () => loadSessionEntry(scope),
    read: (sessionKey: string) => loadSessionEntry({ ...scope, sessionKey }),
    transcript: (sessionKey = sourceKey, sessionId = sourceSessionId) =>
      loadTranscriptEvents({ ...scope, sessionKey, sessionId }),
    placement: <State extends WorkerSessionPlacementRecord["state"]>(state: State) =>
      recoveryWorkerPlacement({ sessionId: sourceSessionId, sessionKey: sourceKey, state }),
    recoverWith: (
      launchContinuation: Parameters<typeof recoverGatewaySession>[0]["launchContinuation"],
    ) =>
      recoverGatewaySession({
        cfg: getRuntimeConfig(),
        key: sourceKey,
        agentId: "main",
        workerPlacementContext: {},
        launchContinuation,
      }),
    recover: <T = SessionsRecoverResult>(options?: Parameters<typeof directSessionReq<T>>[2]) =>
      directSessionReq<T>("sessions.recover", { agentId: "main", key: sourceKey }, options),
  };
}

function placementContext(
  current: () => WorkerSessionPlacementRecord | undefined,
  reclaim?: unknown,
) {
  return {
    workerSessionPlacementService: recoveryPlacementReader(current),
    workerPlacementDispatchService: { dispatch: vi.fn(), ...(reclaim ? { reclaim } : {}) },
  };
}

function runtimeClient(sessionKey: string) {
  return {
    connect: { scopes: ["operator.write"] },
    internal: { agentRuntimeIdentity: { kind: "agentRuntime", agentId: "main", sessionKey } },
  } as never;
}

function roleConfig(
  name: string,
  others: "view" | "write",
  agents: "*" | string[] = "*",
  sandbox?: "required",
) {
  const cfg = getRuntimeConfig();
  const role = {
    sessions: { others },
    agents,
    scopes: ["operator.read" as const, "operator.write" as const],
    ...(sandbox ? { sandbox } : {}),
  };
  return {
    ...cfg,
    gateway: { ...cfg.gateway, roles: { default: name, definitions: { [name]: role } } },
  };
}

function expectRecoveryError(result: unknown, error: Record<string, unknown>) {
  expect(result).toMatchObject({ ok: false, error });
}

function expectUnrecovered(source: ReturnType<typeof loadSessionEntry>) {
  expect(source?.archivedAt).toBeUndefined();
  expect(source?.mainRestartRecovery?.tombstone?.recoveredSessionId).toBeUndefined();
}

async function sessionWorktree(dir: string, name: string, sessionKey: string) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("gateway test state directory is unavailable");
  }
  const repoRoot = await initializeManagedWorktreeTestRepository(dir);
  const worktree = await materializeManagedWorktreeFixture({
    env: process.env,
    name,
    now: Date.now(),
    ownerKind: "session",
    ownerId: sessionKey,
    repoRoot,
    stateDir,
  });
  return {
    worktree,
    entry: {
      spawnedCwd: worktree.path,
      worktree: {
        id: worktree.id,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
        canonicalWorkspaceDir: repoRoot,
      },
    },
  };
}

test("recovery source reads and commit guards execute no host SQLite", async () => {
  const fixture = await recoveryFixture("worker-routed-recovery");
  const sql = observeHostDataSql();
  try {
    const result = await fixture.recoverWith(async () => ({
      status: "started",
      runId: "recovery-proof",
    }));
    expect(result).toMatchObject({ ok: true, created: true });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(fixture.source()?.mainRestartRecovery?.tombstone?.recoveredSessionKey).toBeDefined();
});

test("sessions.recover settles its active placement before archiving a real session-owned worktree", async () => {
  const fixture = await recoveryFixture("recovery-cloud-active");
  const { sourceKey } = fixture;
  const { worktree, entry } = await sessionWorktree(
    fixture.dir,
    "recovery-cloud-active",
    sourceKey,
  );
  const unsyncedPath = path.join(worktree.path, "unsynced.txt");
  await fs.writeFile(unsyncedPath, "preserve local work\n");
  await replaceSessionEntry(fixture.scope, { ...fixture.source()!, ...entry });

  let placement: WorkerSessionPlacementRecord = fixture.placement("active");
  const transition = <State extends "draining" | "reclaimed">(state: State) => {
    const next = { ...fixture.placement(state), generation: placement.generation + 1 };
    placement = next;
    return next;
  };
  const reclaimStarted = createDeferredCore();
  const reclaimGate = createDeferredCore();
  const barriers = reclaimBarriers(() => placement);
  const reclaim = vi.fn(
    async (
      request: { agentId: string; sessionId: string; sessionKey: string },
      authorize?: () => void,
      beforeDrain?: () => void,
    ) =>
      await barriers.runReclaimBarrier({
        ...request,
        authorize,
        beforeDrain,
        begin: async () => transition("draining"),
        reclaim: async (workspace, _placement, reauthorize) => {
          expect(workspace).toEqual({ kind: "local", path: worktree.path });
          reclaimStarted.resolve();
          await reclaimGate.promise;
          reauthorize?.();
          await fs.appendFile(unsyncedPath, "final worker sync\n");
          return transition("reclaimed");
        },
      }),
  );
  const context = placementContext(() => placement, reclaim);

  const recovering = fixture.recover({ context });
  try {
    await awaitGateBeforeSettlement(
      reclaimStarted.promise,
      recovering,
      "recovery committed before reclaim",
    );
    const unsettledSource = fixture.source();
    expect(unsettledSource?.archivedAt).toBeUndefined();
    expect(unsettledSource?.mainRestartRecovery?.tombstone?.recoveredSessionKey).toBeUndefined();
  } finally {
    reclaimGate.resolve();
    await Promise.allSettled([recovering]);
  }

  const recovered = await recovering;
  expect(recovered).toMatchObject({ ok: true, payload: { key: expect.any(String) } });
  expect(placement.state).toBe("reclaimed");
  expect(fixture.source()).toMatchObject({
    archivedAt: expect.any(Number),
    worktree: { id: worktree.id },
  });
  expect(await managedWorktrees.findLiveByOwner("session", sourceKey)).toMatchObject({
    id: worktree.id,
    ownerId: sourceKey,
  });
  expect(
    await managedWorktrees.findLiveByOwner("session", recovered.payload?.key ?? ""),
  ).toBeUndefined();
  expect(fixture.read(recovered.payload?.key ?? "")?.worktree).toBeUndefined();
  await expect(fs.readFile(unsyncedPath, "utf8")).resolves.toBe(
    "preserve local work\nfinal worker sync\n",
  );

  await expect(fixture.recover({ context })).resolves.toMatchObject({
    ok: true,
    payload: { key: recovered.payload?.key },
  });
  expect(reclaim).toHaveBeenCalledOnce();
});

test.each(["before-interrupt", "before-drain"] as const)(
  "automatic reclaim rechecks eligibility after waiting %s",
  async (phase) => {
    const { dir, storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:dashboard:idle-reclaim-${phase}`;
    const sessionId = `idle-reclaim-${phase}`;
    const { entry } = await sessionWorktree(dir, sessionId, sessionKey);
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, entry),
      },
    });
    const placement = recoveryWorkerPlacement({ sessionId, sessionKey, state: "active" });
    const enteredWait = createDeferredCore();
    const releaseWait = createDeferredCore();
    const wait = async () => {
      enteredWait.resolve();
      await releaseWait.promise;
    };
    const onInterrupt = vi.fn();
    let releaseAdmission = () => {};
    const admission =
      phase === "before-interrupt"
        ? await beginSessionEffect({
            scope: storePath,
            identities: [sessionId, sessionKey],
            assertAllowed: () => {},
            onInterrupt: () => {
              onInterrupt();
              releaseAdmission();
            },
          })
        : undefined;
    releaseAdmission = () => admission?.release();
    const begin = vi.fn(async () => ({ ...placement, state: "draining" as const }));
    const reclaim = vi.fn(async () => {
      throw new Error("ineligible worker must not be reclaimed");
    });
    const barriers = reclaimBarriers(
      () => placement,
      async () => {
        if (phase === "before-drain") {
          await wait();
        }
      },
      async () => {
        if (phase === "before-interrupt") {
          await wait();
        }
        return {
          managedWorktrees,
          resolveCanonicalSessionEntryFromStoreKeys,
          resolveGatewaySessionStoreTargetInWorker,
        };
      },
    );
    let eligible = true;
    const eligibilityError = new Error("worker is no longer idle");
    const reclaiming = barriers.runReclaimBarrier({
      sessionId,
      sessionKey,
      agentId: "main",
      beforeDrain: () => {
        if (!eligible) {
          throw eligibilityError;
        }
      },
      begin,
      reclaim,
    });
    const rejected = expect(reclaiming).rejects.toBe(eligibilityError);
    try {
      await enteredWait.promise;
      eligible = false;
      releaseWait.resolve();
      await rejected;
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
      expect(reclaim).not.toHaveBeenCalled();
    } finally {
      releaseWait.resolve();
      admission?.release();
      await Promise.allSettled([reclaiming]);
    }
  },
);

test.each([
  "rejected",
  "unavailable",
  "stale-result",
  "requested",
  "failed",
  "session-id",
  "lifecycle-revision",
] as const)("sessions.recover preserves its source when cloud reclaim is %s", async (failure) => {
  const changedIdentity = failure === "session-id" || failure === "lifecycle-revision";
  const unsettled = failure === "requested" || failure === "failed";
  const fixture = await recoveryFixture(`recovery-cloud-${failure}`, {
    lifecycleRevision: "original-lifecycle",
  });
  let placement: WorkerSessionPlacementRecord = fixture.placement(unsettled ? failure : "active");
  const reclaim = vi.fn(async () => {
    if (failure === "rejected") {
      throw new Error("final workspace reconciliation rejected");
    }
    if (changedIdentity) {
      const current = fixture.source();
      if (!current) {
        throw new Error("recovery source disappeared");
      }
      await replaceSessionEntry(fixture.scope, {
        ...current,
        ...(failure === "session-id"
          ? { sessionId: "replacement-session" }
          : { lifecycleRevision: "replacement-lifecycle" }),
      });
      placement = fixture.placement("reclaimed");
    }
    return fixture.placement("reclaimed");
  });
  const recovered = await fixture.recover({
    context: placementContext(() => placement, failure === "unavailable" ? undefined : reclaim),
  });
  expectRecoveryError(recovered, {
    code: changedIdentity ? "INVALID_REQUEST" : "UNAVAILABLE",
    ...(!changedIdentity ? { retryable: true } : {}),
    message: expect.stringContaining(
      changedIdentity ? "changed" : unsettled ? failure : "sessions.reclaim",
    ),
  });
  expectUnrecovered(fixture.source());
  expect(reclaim).toHaveBeenCalledTimes(unsettled || failure === "unavailable" ? 0 : 1);
});

test("sessions.recover preserves device-folder affinity before launching its successor", async () => {
  const deviceFolder = { deviceId: "recovery-device", path: "/existing/project" };
  const fixture = await recoveryFixture("device-folder-recovery", { deviceFolder });
  const launchContinuation = vi.fn(async (target: { sessionKey: string; storePath: string }) => {
    expect(loadSessionEntry(target)?.deviceFolder).toEqual(deviceFolder);
    return { status: "started" as const, runId: "device-folder-recovery-run" };
  });
  const result = await fixture.recoverWith(launchContinuation);
  expect(result).toMatchObject({
    ok: true,
    created: true,
    successorEntry: { deviceFolder },
  });
  expect(launchContinuation).toHaveBeenCalledOnce();
  expect(fixture.source()?.deviceFolder).toEqual(deviceFolder);
});

test("sessions.recover rolls over one tombstone and returns its continuation outcome", async () => {
  testState.sessionConfig = { dmScope: "main", scope: "per-sender" };
  const inherited: Parameters<typeof sessionStoreEntry>[1] = {
    agentHarnessId: "codex",
    agentRuntimeOverride: "codex",
    providerOverride: "openai",
    modelOverride: "gpt-5.6-sol",
    modelSelectionLocked: true,
    sandbox: "required",
    communication: { send: "never", receive: "ask" },
    spawnedCwd: "/tmp/recovered-worktree",
  };
  const fixture = await recoveryFixture(
    "tombstoned",
    {
      ...inherited,
      pinnedAt: 1,
      mainRestartRecovery: {
        cycleId: "cycle-tombstoned",
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    },
    [
      { role: "user", content: "finish the interrupted implementation" },
      { role: "assistant", content: [{ type: "text", text: "I reached the final check." }] },
    ],
  );
  const { sourceSessionId } = fixture;
  const sourceTranscriptBefore = await fixture.transcript();

  type RecoveryPayload = {
    key: string;
    sessionId: string;
    continuation: { status: string; runId?: string };
  };
  const [recovered, concurrentRetry] = await Promise.all([
    fixture.recover<RecoveryPayload>(),
    fixture.recover<RecoveryPayload>(),
  ]);

  expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
  expect(recovered.payload).toMatchObject({
    key: expect.stringMatching(/^agent:main:dashboard:/),
    sessionId: expect.any(String),
    continuation: { status: "started", runId: expect.any(String) },
  });
  const successorKey = recovered.payload?.key ?? "";
  const successorSessionId = recovered.payload?.sessionId ?? "";
  const expectedRetry = {
    ok: true,
    payload: {
      key: successorKey,
      sessionId: successorSessionId,
      continuation: { status: "started" },
    },
  };
  expect(concurrentRetry, JSON.stringify(concurrentRetry)).toMatchObject(expectedRetry);
  expect(fixture.read(successorKey)).toMatchObject({
    ...inherited,
    previousSessionId: sourceSessionId,
  });
  const archivedSource = fixture.source();
  expect(archivedSource).toMatchObject({
    archivedAt: expect.any(Number),
    mainRestartRecovery: {
      revision: 5,
      tombstone: {
        recoveredSessionId: successorSessionId,
        recoveredSessionKey: successorKey,
      },
    },
  });
  expect(archivedSource).not.toHaveProperty("pinnedAt");
  await expect(fixture.transcript()).resolves.toEqual(sourceTranscriptBefore);
  expect(JSON.stringify(await fixture.transcript(successorKey, successorSessionId))).toContain(
    "finish the interrupted implementation",
  );

  const repeated = await fixture.recover<RecoveryPayload>();
  expect(repeated, JSON.stringify(repeated)).toMatchObject(expectedRetry);
});

test.each([
  { identity: "operator", required: false },
  { identity: "operator", required: true },
  { identity: "owner", required: false },
  { identity: "owner", required: true },
  { identity: "identityless", required: false },
  { identity: "identityless", required: true },
] as const)(
  "sessions.recover preserves $identity isolation (profile requirement: $required)",
  async ({ identity, required }) => {
    const systemActor = identity !== "operator";
    const owner = ensureProfileForEmail("recovery-source-owner@example.test");
    const recovering =
      identity === "identityless"
        ? undefined
        : systemActor
          ? ensureGatewayOwnerProfile("Gateway Owner")
          : ensureProfileForEmail("recovery-requester@example.test");
    if (recovering && !systemActor) {
      setUserProfileRole(recovering.id, "requester");
    }
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const sourceStamp = {
      createdVia: "operator" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
      createdAt: 123,
      ...(!required ? { sandbox: "required" as const } : {}),
    };
    const fixture = await recoveryFixture("creator-policy-recovery", {
      ...sourceStamp,
      visibility: "shared",
    });
    const cfg = roleConfig("requester", "write", "*", required ? "required" : undefined);
    const currentConfig =
      identity === "owner" ? { ...cfg, gateway: { ...cfg.gateway, roles: undefined } } : cfg;
    const request = {
      client: {
        ...(systemActor && identity !== "owner"
          ? { internal: { operatorRoleActor: { kind: "system" as const } } }
          : {}),
        connect: gatewayConnect(["operator.write"], { id: "test", mode: "test" }, 3),
        ...(recovering
          ? {
              authenticatedUserProfile: gatewayProfile(
                recovering.id,
                recovering.displayName,
                recovering.updatedAt,
              ),
            }
          : {}),
      },
      context: {
        getRuntimeConfig: () => currentConfig,
        getCommittedRuntimeConfig: () => currentConfig,
      },
    };
    prepareGatewayRecipientProfile(request.client);
    type RecoveryPayload = { key: string; continuation: { status: string } };
    const recovered = await fixture.recover<RecoveryPayload>(request);
    expect(recovered).toMatchObject({
      ok: true,
      payload: { key: expect.any(String), continuation: { status: "started" } },
    });
    const successorKey = recovered.payload?.key ?? "";
    const successor = fixture.read(successorKey);
    expect(successor).toMatchObject({
      createdVia: "operator",
      createdAt: expect.any(Number),
    });
    expect(successor?.createdActor).toEqual(
      recovering
        ? { type: "human", source: "profile", id: recovering.id }
        : sourceStamp.sandbox === "required"
          ? sourceStamp.createdActor
          : undefined,
    );
    expect(successor?.sandbox).toBe((systemActor ? !required : required) ? "required" : undefined);
    expect(successor?.createdAt).not.toBe(sourceStamp.createdAt);
    const repeated = await fixture.recover<RecoveryPayload>(request);
    expect(repeated.payload?.key).toBe(successorKey);
    const repeatedEntry = fixture.read(successorKey);
    expect(repeatedEntry?.createdActor).toEqual(successor?.createdActor);
    expect(repeatedEntry?.createdAt).toBe(successor?.createdAt);
    expect(repeatedEntry?.sandbox).toBe(successor?.sandbox);
    const source = fixture.source();
    expect(source).toMatchObject(sourceStamp);
    expect(source?.sandbox).toBe(required ? undefined : "required");
  },
);

test("sessions.recover cannot create a successor on an agent excluded by the caller's role", async () => {
  const profile = ensureProfileForEmail("restricted-session-recovery@example.com");
  setUserProfileRole(profile.id, "guest");
  const fixture = await recoveryFixture("role-denied-recovery", {
    createdActor: { type: "human", source: "profile", id: profile.id },
  });
  using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
  const cfg = roleConfig("guest", "view", ["guest-only"]);
  const client = {
    connect: { role: "operator", scopes: ["operator.write"] },
    authenticatedUserProfile: gatewayProfile(profile.id, profile.displayName, profile.updatedAt),
  } as never;

  const recovered = await fixture.recover({ client, context: { getRuntimeConfig: () => cfg } });

  expectRecoveryError(recovered, {
    code: "FORBIDDEN",
    message: expect.stringContaining('agent "main"'),
  });
  expect(fixture.source()).toMatchObject({
    mainRestartRecovery: {
      revision: 1,
      tombstone: { reason: "automatic recovery exhausted" },
    },
  });
});

test("sessions.recover revalidates participation at the recovery writer commit", async () => {
  const fixture = await recoveryFixture("recovery-participation-race", {
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "owner" },
  });
  const { sourceKey, sourceSessionId, scope } = fixture;
  addSessionMember(scope, {
    identityId: "member",
    addedBy: "owner",
    expectedSessionId: sourceSessionId,
  });
  const client = {
    authenticatedUserId: "member@example.com",
    authenticatedUserProfile: gatewayProfile("member", "Member"),
    connect: { role: "operator", scopes: ["operator.write"] },
  } as never;
  // Use an already-registered single-key mutation to isolate handler/writer propagation from
  // the separate sessions.recover registry regression covered at the router boundary.
  const authorization = await resolveSessionMutationAuthorizationAsync({
    client,
    method: "sessions.reset",
    requestParams: { key: sourceKey, agentId: "main" },
    context: { getRuntimeConfig } as never,
  });
  using _ = { [Symbol.dispose]: () => authorization.authorization?.release?.() };
  expect(authorization.error).toBeNull();
  if (!authorization.authorization) {
    throw new Error("failed to capture recovery source participation");
  }

  const mutationEntered = createDeferredCore();
  const releaseMutation = createDeferredCore();
  const heldMutation = runSessionMutation({
    scope: scope.storePath,
    identities: [sourceKey, sourceSessionId],
    run: async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationEntered.promise;
  const requestStarted = createDeferredCore();
  const recovering = fixture.recover({
    client,
    context: {
      getRuntimeConfig: () => {
        requestStarted.resolve();
        return getRuntimeConfig();
      },
    },
    sessionMutationAuthorization: authorization.authorization,
  });

  try {
    await requestStarted.promise;
    removeSessionMember(scope, "member", undefined, sourceSessionId);
  } finally {
    releaseMutation.resolve();
    await heldMutation;
  }

  await expect(recovering).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
  const source = fixture.source();
  expect(source?.archivedAt).toBeUndefined();
  expect(source?.mainRestartRecovery?.tombstone).not.toHaveProperty("recoveredSessionKey");
  expect(source?.mainRestartRecovery?.tombstone).not.toHaveProperty("recoveredSessionId");
});

test("sessions.recover revalidates runtime authority after its cloud placement reclaim", async () => {
  const fixture = await recoveryFixture("recovery-cloud-authority-race");
  let authorityActive = true;
  let placement = fixture.placement("active");
  const reclaim = vi.fn(async (_request: unknown, authorize?: () => void) => {
    authorize?.();
    authorityActive = false;
    placement = fixture.placement("reclaimed");
    return placement;
  });

  const recovered = await fixture.recover({
    client: runtimeClient(fixture.sourceKey),
    context: {
      validateAgentRuntimeApprovalAuthority: () => authorityActive,
      ...placementContext(() => placement, reclaim),
    },
  });

  expectRecoveryError(recovered, {
    code: "INVALID_REQUEST",
    message: "agent runtime authority is no longer active",
  });
  expect(reclaim).toHaveBeenCalledOnce();
  expectUnrecovered(fixture.source());
});

test("sessions.recover rejects continuation launch after runtime authority closes", async () => {
  const fixture = await recoveryFixture("authority-race");
  const recovered = await fixture.recover<{
    key: string;
    continuation: { status: string; error?: { message?: string } };
  }>({
    context: {
      validateAgentRuntimeApprovalAuthority: () =>
        !fixture.source()?.mainRestartRecovery?.tombstone?.recoveredSessionKey,
    },
    client: runtimeClient(fixture.sourceKey),
  });

  expect(recovered).toMatchObject({
    ok: true,
    payload: {
      continuation: {
        status: "rejected",
        error: {
          code: "INVALID_REQUEST",
          message: "agent runtime authority is no longer active",
        },
      },
    },
  });
  expect(agentCommandMock).not.toHaveBeenCalled();
  expect(fixture.read(recovered.payload?.key ?? "")).toBeDefined();
});
