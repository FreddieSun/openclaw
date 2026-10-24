import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import { WorkerEnvironmentInventoryClosedError } from "./store-errors.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
type WorkerLifecycleLease = support.WorkerLifecycleLease;

function holdBootstrap() {
  const pending = createDeferred();
  const entered = createDeferred();
  support.testState.bootstrapWorker = vi.fn(async () => {
    entered.resolve();
    await pending.promise;
    return support.BOOTSTRAP_RECEIPT;
  });
  return { entered: entered.promise, release: pending.resolve };
}

async function seedProvisioning(environmentId: string) {
  await support.testState.store.createIntent({
    environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: { region: "test" } },
    provisionOperationId: `provision:${environmentId}`,
  });
  return support.testState.store.transition({
    environmentId,
    from: "requested",
    to: "provisioning",
  });
}

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("cancels an in-flight inspection on suspend and reconciles again after resume", async () => {
    const environment = await support.seedReady("suspend-in-flight");
    const entered = createDeferred<AbortSignal | undefined>();
    const release = createDeferred();
    const inspect = vi.fn(async ({ signal }: WorkerLifecycleLease) => {
      entered.resolve(signal);
      await racePromiseWithAbortSignal(release.promise, signal);
      return { status: "active" as const };
    });
    const workerService = support.createService(support.createProvider({ inspect }));
    const reconciliation = workerService.reconcileOnce();
    try {
      const signal = await entered.promise;
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension).not.toBeNull();
      expect(signal?.aborted).toBe(true);
      await reconciliation;
      expect(support.testState.store.get(environment.environmentId)).toEqual(environment);
      suspension?.rollback();
      release.resolve();
      await workerService.reconcileOnce();
      expect(inspect).toHaveBeenCalledTimes(2);
    } finally {
      resetGatewayWorkAdmission();
      release.resolve();
      await reconciliation;
    }
  });

  it.each(["stop", "inspection budget"] as const)(
    "releases a late read-only inspection on %s without publishing its result",
    async (reason) => {
      const environment = await support.seedReady("late-inspection");
      const entered = createDeferred<AbortSignal | undefined>();
      const release = createDeferred();
      const workerService = support.createService(
        support.createProvider({
          inspect: async ({ signal }) => {
            entered.resolve(signal);
            await release.promise;
            return { status: "unknown" };
          },
        }),
      );
      if (reason === "inspection budget") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const reconciliation = workerService.reconcileOnce();
      try {
        const signal = await entered.promise;
        if (reason === "stop") {
          await workerService.stop();
        } else {
          await vi.advanceTimersByTimeAsync(15_000);
        }
        expect(signal?.aborted).toBe(true);
        await reconciliation;
        expect(workerService.get(environment.environmentId)).toMatchObject({
          state: environment.state,
          ownerEpoch: environment.ownerEpoch,
          destroyRequestedAtMs: null,
          lastError:
            reason === "stop" ? environment.lastError : expect.stringContaining("15s budget"),
        });
      } finally {
        vi.useRealTimers();
        release.resolve();
        await reconciliation;
      }
      expect(workerService.get(environment.environmentId)?.destroyRequestedAtMs).toBeNull();
    },
  );

  it("cancels an idle reconciliation's owner lookup before joining the guard", async () => {
    const environment = await support.seedReady("shutdown-owner-read");
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const entered = createDeferred();
    const release = createDeferred<undefined>();
    vi.spyOn(placements, "readEnvironmentOwner").mockImplementation(async (_id, signal) => {
      entered.resolve();
      return racePromiseWithAbortSignal(release.promise, signal);
    });
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const service = support.createService(support.createProvider({ inspect }));
    installWorkerPlacementReconcileGuard({
      placements,
      environments: service,
      dispatch: {
        resumeProvisioning: async () => {
          throw new Error("Idle environment must not provision");
        },
        hasPendingPlacementLifecycleOperation: () => false,
      },
      isStopping: service.isStopping,
    });
    const reconciliation = service.reconcileEnvironment(environment.environmentId);
    await entered.promise;
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    try {
      await support.waitForFast(() => expect(stopped).toBe(true));
      expect(inspect).not.toHaveBeenCalled();
      expect(support.testState.store.get(environment.environmentId)).toEqual(environment);
    } finally {
      release.resolve(undefined);
      await Promise.all([reconciliation, stopping]);
    }
  });

  it.each([false, true])(
    "withdraws dedicated access before persistence settles (rejected=%s)",
    async (rejected) => {
      const node = await support.seedReadyNodeDesktop("preview-withdrawal");
      let sharedHost: boolean | undefined = false;
      const service = support.createService(
        support.createProvider({
          resolveAllocation: async () => ({ leaseId: node.leaseId!, sharedHost: false }),
          inspect: async () => ({ status: "active", sharedHost }),
        }),
      );
      await service.reconcileOnce();
      const qualification = service.getDedicatedNodeLeaseSignal(node.environmentId)!;
      expect(qualification.aborted).toBe(false);
      const entered = createDeferred();
      const finish = createDeferred();
      const store = support.testState.store;
      const persist = store.reconcileSharedHost.bind(store);
      vi.spyOn(store, "reconcileSharedHost").mockImplementationOnce(async (input) => {
        entered.resolve();
        await finish.promise;
        if (rejected) {
          throw new Error("fixture persistence failure");
        }
        return persist(input);
      });
      sharedHost = undefined;
      const reconciliation = service.reconcileOnce();
      try {
        await entered.promise;
        expect(qualification.aborted).toBe(true);
        expect(service.getDedicatedNodeLeaseSignal(node.environmentId)).toBeUndefined();
      } finally {
        finish.resolve();
        await reconciliation;
      }
      expect(service.getDedicatedNodeLeaseSignal(node.environmentId)).toBeUndefined();
    },
  );

  it("requires fresh explicit dedicated-node inspection for restricted previews without changing legacy classification", async () => {
    const node = await support.seedReadyNodeDesktop("preview-dedicated");
    let sharedHost: boolean | undefined;
    let inspectionFails = false;
    const provider = support.createProvider({
      resolveAllocation: async () => ({ leaseId: node.leaseId!, sharedHost: false }),
      inspect: async () => {
        if (inspectionFails) {
          throw new Error("provider temporarily unavailable");
        }
        return { status: "active", ...(sharedHost === undefined ? {} : { sharedHost }) };
      },
    });
    const service = support.createService(provider);
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    await service.reconcileOnce();
    expect(service.get(node.environmentId)?.sharedHost).toBe(false);
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    sharedHost = false;
    await service.reconcileOnce();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(true);
    const firstQualification = service.getDedicatedNodeLeaseSignal(node.environmentId)!;
    await service.reconcileOnce();
    expect(service.getDedicatedNodeLeaseSignal(node.environmentId)).toBe(firstQualification);
    expect(firstQualification.aborted).toBe(false);
    inspectionFails = true;
    await service.reconcileOnce();
    expect(service.getDedicatedNodeLeaseSignal(node.environmentId)).toBe(firstQualification);
    expect(firstQualification.aborted).toBe(false);
    inspectionFails = false;
    sharedHost = undefined;
    await service.reconcileOnce();
    expect(service.get(node.environmentId)?.sharedHost).toBe(false);
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    expect(firstQualification.aborted).toBe(true);
    sharedHost = false;
    await service.reconcileOnce();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(true);
    sharedHost = true;
    await service.reconcileOnce();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    sharedHost = false;
    await service.reconcileOnce();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(true);
    await service.stop();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    const restarted = support.createService(provider);
    expect(Boolean(restarted.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    await restarted.reconcileOnce();
    expect(Boolean(restarted.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(true);
    const epoch = restarted.get(node.environmentId)!.ownerEpoch;
    const restartedQualification = restarted.getDedicatedNodeLeaseSignal(node.environmentId)!;
    await support.testState.store.revokeEnvironmentCredential(node.environmentId);
    expect(restarted.getDedicatedNodeLeaseSignal(node.environmentId)).toBe(restartedQualification);
    expect(restartedQualification.aborted).toBe(false);
    await support.testState.store.revokeEnvironmentCredential(node.environmentId, {
      expectedOwnerEpoch: epoch,
      fenceWorkspaceTransfers: true,
    });
    expect(Boolean(restarted.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    expect(restartedQualification.aborted).toBe(true);
  });

  it("warms machine catalogs at startup only for nonterminal environment profiles", async () => {
    const { store } = support.testState;
    const active = await store.createIntent({
      environmentId: "startup-worker",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:startup",
    });
    await store.createIntent({
      environmentId: "terminal-worker",
      providerId: "fake",
      profileId: "terminal",
      profileSnapshot: { settings: { region: "terminal" } },
      provisionOperationId: "provision:terminal",
    });
    await store.transition({ environmentId: "terminal-worker", from: "requested", to: "failed" });
    support.testState.config.cloudWorkers!.profiles!.terminal = {
      provider: "fake",
      settings: { region: "terminal" },
    };
    const listMachineOptions = vi.fn(async () => [
      { id: "medium", label: "Medium", cpu: 4, memoryGb: 16, default: true },
    ]);
    const listOperatingSystems = vi.fn(async () => [
      { id: "linux", label: "Linux", default: true },
    ]);
    const service = support.createService(
      support.createProvider({ listMachineOptions, listOperatingSystems }),
    );
    service.installReconcileEnvironmentGuard(async () => {});
    expect(service.readMachineShape(active.environmentId)).toBeUndefined();
    service.start();
    await support.waitForFast(() =>
      expect(service.readMachineShape(active.environmentId)).toEqual({
        class: "medium",
        os: "linux",
        osLabel: "Linux",
        cpu: 4,
        memoryGb: 16,
      }),
    );
    expect(listMachineOptions).toHaveBeenCalledExactlyOnceWith({ region: "test" });
    expect(listOperatingSystems).toHaveBeenCalledExactlyOnceWith({ region: "test" });
    expect(store.get(active.environmentId)?.profileSnapshot).toEqual(active.profileSnapshot);
  });

  it("reports failed maintenance and retries on the next sweep", async () => {
    const warn = vi.fn();
    const maintainProviders = vi.fn(async () => {
      throw new Error("fixture maintenance failure");
    });
    const workerService = support.createService(support.createProvider(), {
      maintainProviders,
      logger: { warn },
    });
    await workerService.reconcileOnce();
    await support.waitForFast(() => expect(warn).toHaveBeenCalledOnce());
    await workerService.reconcileOnce();
    await support.waitForFast(() => expect(maintainProviders).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledWith(
      "Worker provider maintenance sweep failed; cleanup will retry",
    );
  });

  it("coalesces targeted and full inspection while retaining full-sweep maintenance", async () => {
    const targetId = "worker-targeted-overlap";
    const siblingId = "worker-full-sweep-sibling";
    await support.seedReady(targetId);
    await support.seedReady(siblingId);
    const targetStarted = createDeferred();
    const siblingStarted = createDeferred();
    const finishTarget = createDeferred();
    const finishMaintenance = createDeferred();
    const inspect = vi.fn(async ({ leaseId }: WorkerLifecycleLease) => {
      if (leaseId === `lease:${targetId}`) {
        targetStarted.resolve();
        await finishTarget.promise;
      } else {
        siblingStarted.resolve();
      }
      return { status: "active" as const };
    });
    const maintainProviders = vi.fn(async () => await finishMaintenance.promise);
    const prune = vi.spyOn(support.testState.store, "pruneTerminalEnvironments");
    const workerService = support.createService(support.createProvider({ inspect }), {
      maintainProviders,
    });
    const uninstall = workerService.installReconcileEnvironmentGuard(async (_id, core) => {
      await core();
    });
    const targeted = workerService.reconcileOnce(targetId);
    let direct: Promise<void> | undefined;
    let full: Promise<void> | undefined;
    try {
      await targetStarted.promise;
      expect(inspect.mock.calls.map(([lease]) => lease.leaseId)).toEqual([`lease:${targetId}`]);
      expect(maintainProviders).not.toHaveBeenCalled();
      expect(prune).not.toHaveBeenCalled();
      direct = workerService.reconcileEnvironment(targetId);
      full = workerService.reconcileOnce();
      await siblingStarted.promise;
      expect(inspect).toHaveBeenCalledTimes(2);
      await expect(
        workerService.createWithRequest({
          profileId: "development",
          idempotencyKey: "during-maintenance",
        }),
      ).resolves.toMatchObject({ state: "ready" });
    } finally {
      finishTarget.resolve();
      finishMaintenance.resolve();
      await Promise.all([targeted, direct, full]);
      await uninstall();
    }
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(maintainProviders).toHaveBeenCalledOnce();
    expect(prune).toHaveBeenCalledOnce();
  });

  it("skips terminal retention reads for empty inventory and resumes after a committed create", async () => {
    const prune = vi.spyOn(support.testState.store, "pruneTerminalEnvironments");
    const workerService = support.createService(support.createProvider());

    await workerService.reconcileOnce();
    await workerService.reconcileOnce();
    expect(prune).not.toHaveBeenCalled();

    await support.seedReady("retention-created-worker");
    await workerService.reconcileOnce();
    expect(prune).toHaveBeenCalledOnce();
  });

  it("propagates terminal cleanup failures", async () => {
    await support.seedReady("retention-failure-worker");
    const error = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    const prune = vi
      .spyOn(support.testState.store, "pruneTerminalEnvironments")
      .mockImplementation(() => {
        throw error;
      });

    await expect(support.createService(support.createProvider()).reconcileOnce()).rejects.toBe(
      error,
    );
    expect(prune).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "settles provisioning before reporting a timeout (committed=%s)",
    async (committed) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const transitionEntered = createDeferred();
      const releaseTransition = createDeferred();
      const store = support.testState.store;
      const transition = store.transition.bind(store);
      vi.spyOn(store, "transition").mockImplementation(async (input) => {
        if (input.from !== "requested" || input.to !== "provisioning") {
          return transition(input);
        }
        if (committed) {
          const record = await transition(input);
          transitionEntered.resolve();
          await releaseTransition.promise;
          return record;
        }
        transitionEntered.resolve();
        await releaseTransition.promise;
        return transition(input);
      });
      const provision = vi.fn(support.createProvider().provision);
      const workerService = support.createService(support.createProvider({ provision }), {
        providerCallTimeoutMs: 5,
      });
      const creationResult = workerService
        .createWithRequest({
          profileId: "development",
          idempotencyKey: "request-provision-transition-timeout",
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        await Promise.race([
          transitionEntered.promise,
          creationResult.then((result) => {
            throw new Error("Creation ended before provisioning transition", { cause: result });
          }),
        ]);
        await vi.advanceTimersByTimeAsync(5);
      } finally {
        releaseTransition.resolve();
        await creationResult;
      }

      expect(await creationResult).toMatchObject({
        ok: false,
        error: { code: "provider_failure" } satisfies Partial<WorkerEnvironmentServiceError>,
      });
      expect(provision).not.toHaveBeenCalled();
      expect(store.list()[0]).toMatchObject({
        state: committed ? "provisioning" : "failed",
        lastError: "Worker provider operation timed out after 5ms",
      });
    },
  );

  it("defers unreachable worker stops instead of failing Gateway shutdown", async () => {
    const disconnected = new WorkerTunnelOwnerDisconnectedError("node is not connected");
    const workerService = support.createService(support.createProvider(), {
      tunnelManager: {
        stopAll: vi.fn(async () => {
          throw disconnected;
        }),
      } as unknown as WorkerTunnelManager,
    });

    await expect(workerService.stop()).resolves.toBeUndefined();
  });

  it("reconciles periodically through the placement guard and retires the schedule on stop", async () => {
    const environmentId = "worker-guarded-reconcile";
    await support.seedReady(environmentId);
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const liveEvents = support.createLiveEvents();
    const unsubscribeTurnClaimClosed = vi.fn();
    const placementStore = {
      fenceWorkerTurnForRecovery: vi.fn(),
      prepareWorkerRuntimeRefresh: vi.fn(async () => {
        throw new Error("Runtime refresh is outside this timer fixture");
      }),
      readWorkerTurnClaim: vi.fn(),
      readWorkerTurnLiveAckCursor: vi.fn(() => 0),
      validateWorkerTurn: vi.fn(() => false),
      isWorkerTurnToolAuthorized: vi.fn(() => false),
      updateAckCursors: vi.fn(async () => {}),
      prepareWorkspaceResultOwnerRevocation: vi.fn(async () => {}),
      registerTurnClaimClosedHandler: vi.fn(() => unsubscribeTurnClaimClosed),
    };
    const workerService = support.createService(support.createProvider({ inspect }), {
      liveEvents,
      placementStore,
      scheduler,
    });
    const guardedEnvironmentIds: string[] = [];
    const uninstallGuard = workerService.installReconcileEnvironmentGuard(
      async (guardedEnvironmentId, reconcileCore) => {
        guardedEnvironmentIds.push(guardedEnvironmentId);
        await reconcileCore();
      },
    );

    expect(placementStore.registerTurnClaimClosedHandler).toHaveBeenCalledOnce();
    await workerService.reconcileEnvironment(environmentId);
    workerService.start();
    workerService.start();
    await workerService.reconcileOnce();
    await time.advanceBy(25);
    await workerService.reconcileOnce();
    expect(guardedEnvironmentIds).toEqual([environmentId, environmentId, environmentId]);
    expect(inspect).toHaveBeenCalledTimes(3);
    await uninstallGuard();
    await workerService.reconcileEnvironment(environmentId);
    expect(guardedEnvironmentIds).toHaveLength(3);
    expect(inspect).toHaveBeenCalledTimes(4);
    await workerService.stop();

    expect(liveEvents.clear).toHaveBeenCalledTimes(2);
    expect(unsubscribeTurnClaimClosed).toHaveBeenCalledOnce();
    await time.advanceBy(25);
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it.each(["uninstall", "reconcileEnvironment", "reconcileOnce"] as const)(
    "drains admitted guarded recovery and closes new admission during %s",
    async (closure) => {
      const environmentId = "worker-guard-close";
      await support.seedReady(environmentId);
      const inspect = vi.fn(async () => ({ status: "active" as const }));
      const service = support.createService(support.createProvider({ inspect }));
      const pending = createDeferred();
      const entered = createDeferred();
      let guardCompleted = false;
      const uninstall = service.installReconcileEnvironmentGuard(async (_id, core) => {
        entered.resolve();
        await pending.promise;
        await core();
        guardCompleted = true;
      });
      const method = closure === "uninstall" ? "reconcileEnvironment" : closure;
      const admitted = service[method](environmentId);
      await entered.promise;
      let closed = false;
      const closing = (closure === "uninstall" ? uninstall() : service.stop()).then(() => {
        closed = true;
      });
      await service[method](environmentId);
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(guardCompleted).toBe(false);
      expect(inspect).not.toHaveBeenCalled();
      pending.resolve();
      await Promise.all([admitted, closing]);
      expect(guardCompleted).toBe(true);
      if (closure === "uninstall") {
        expect(inspect).toHaveBeenCalledOnce();
        await service.reconcileEnvironment(environmentId);
        expect(inspect).toHaveBeenCalledTimes(2);
      } else {
        await uninstall();
        expect(inspect).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["create", "destroy"] as const)(
    "settles a queued %s across shutdown after its environment lock is acquired",
    async (operation) => {
      const bootstrap = holdBootstrap();
      const provision = vi.fn(support.createProvider().provision);
      const destroy = vi.fn(async () => {});
      const service = support.createService(support.createProvider({ provision, destroy }));
      const request = { profileId: "development", idempotencyKey: "queued-before-stop" };
      const first = service.createWithRequest(request);
      await bootstrap.entered;
      let queuedResult: Promise<unknown>;
      if (operation === "create") {
        queuedResult = expect(service.createWithRequest(request)).rejects.toMatchObject({
          code: "invalid_state",
        } satisfies Partial<WorkerEnvironmentServiceError>);
      } else {
        const environmentId = support.testState.store.list()[0]?.environmentId;
        expect(environmentId).toBeTruthy();
        queuedResult = expect(service.destroy(environmentId!)).resolves.toMatchObject({
          state: "destroyed",
        });
      }
      const stopping = service.stop();
      bootstrap.release();
      await expect(first).resolves.toMatchObject({ state: "ready" });
      await queuedResult;
      await stopping;
      expect(operation === "create" ? provision : destroy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "settles inventory retirement during reconciliation (stopping=%s)",
    async (stopping) => {
      const ready = createDeferred();
      const closed = new WorkerEnvironmentInventoryClosedError();
      vi.spyOn(support.testState.store, "ready").mockReturnValue(ready.promise);
      const service = support.createService(support.createProvider());
      const reconciliation = service.reconcileOnce("retired-environment");
      const result = stopping
        ? expect(reconciliation).resolves.toBeUndefined()
        : expect(reconciliation).rejects.toBe(closed);
      const stopped = stopping ? service.stop() : undefined;
      ready.reject(closed);
      await result;
      await stopped;
    },
  );

  it("drains accepted operations after readiness rejects during shutdown", async () => {
    const durableStore = support.testState.store;
    const bootstrap = holdBootstrap();
    const workerService = support.createService(support.createProvider());
    const creation = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-stop-after-reconcile-failure",
    });
    await bootstrap.entered;
    try {
      vi.spyOn(durableStore, "ready").mockRejectedValueOnce(
        new Error("reconcile database read failed"),
      );
      const reconciliation = workerService.reconcileOnce("reconcile-failure");
      const reconciliationResult = expect(reconciliation).rejects.toThrow(
        "reconcile database read failed",
      );
      let stopped = false;
      const stopping = workerService.stop().then(() => {
        stopped = true;
      });

      await reconciliationResult;
      await Promise.resolve();
      expect(stopped).toBe(false);
      bootstrap.release();

      await expect(creation).resolves.toMatchObject({ state: "ready" });
      await stopping;
      expect(stopped).toBe(true);
      expect(durableStore.list()).toHaveLength(1);
    } finally {
      bootstrap.release();
    }
  });

  it.each([
    ...(["provision", "provision-node", "bootstrap", "bundle", "npm", "refresh"] as const).map(
      (kind) => ({ kind, interruption: "service" as const }),
    ),
    ...(["bootstrap", "provision-node"] as const).flatMap((kind) =>
      (["scheduler", "suspend"] as const).map((interruption) => ({ kind, interruption })),
    ),
  ])(
    "retains the $kind producer and lease through $interruption cancellation",
    async ({ kind, interruption }) => {
      const environmentId = "worker-owner-cancellation";
      const preparing = kind === "bundle" || kind === "npm";
      const initial = await (kind === "provision" || kind === "provision-node"
        ? seedProvisioning(environmentId)
        : kind === "refresh"
          ? support.seedReadyNodeDesktop(environmentId)
          : kind === "bootstrap" || preparing
            ? support.seedBootstrapping(environmentId, kind === "npm" ? "npm" : "bundle")
            : support.seedReady(environmentId));
      const entered = createDeferred();
      const finishProducer = createDeferred();
      let activeSignal: AbortSignal | undefined;
      let producerSettled = false;
      const holdProducer = async (signal?: AbortSignal) => {
        activeSignal = signal;
        entered.resolve();
        await finishProducer.promise;
        producerSettled = true;
      };
      if (kind === "bootstrap") {
        support.testState.bootstrapWorker = vi.fn(async ({ signal }) => {
          await holdProducer(signal);
          signal.throwIfAborted();
          return support.BOOTSTRAP_RECEIPT;
        });
      }
      if (preparing || kind === "refresh") {
        support.testState.prepareInstallation = vi.fn(async (install) => {
          if (install === kind) {
            await holdProducer();
          }
          return install === "bundle"
            ? { ...support.BUNDLE_ARTIFACT, bundleHash: "c".repeat(64) }
            : support.NPM_ARTIFACT;
        });
      }
      const destroy = vi.fn(async () => {});
      const scheduler = createTestGatewayScheduler();
      const provider = support.createProvider({
        provision: async (_profile, _operationId, options) => {
          if (kind === "provision-node") {
            return { leaseId: "lease:provisioning", node: { deviceId: "node:provisioning" } };
          }
          await holdProducer(options?.signal);
          options?.signal?.throwIfAborted();
          return { leaseId: "lease:unexpected", ssh: support.SSH_ENDPOINT };
        },
        inspect: async () => ({ status: "active" }),
        destroy,
      });
      const workerService = support.createService(provider, {
        scheduler,
        ensureNodeWorkerBundle: async ({ signal }) => {
          await holdProducer(signal);
          signal?.throwIfAborted();
          return support.BOOTSTRAP_RECEIPT;
        },
      });
      let stopping: Promise<void> | undefined;
      let stopped = false;
      const reconciled = workerService.reconcileEnvironment(environmentId).catch(() => undefined);
      try {
        await entered.promise;
        if (!preparing) {
          expect(activeSignal?.aborted).toBe(false);
        }
        if (interruption === "service") {
          workerService.beginClose();
        } else if (interruption === "scheduler") {
          scheduler.beginClose();
        } else {
          expect(tryBeginGatewaySuspendAdmission(() => {})).not.toBeNull();
        }
        if (!preparing) {
          expect(activeSignal?.aborted).toBe(true);
        } else {
          // The consumer releases its lock; stop still owns the real packaging producer.
          await reconciled;
        }
        expect(producerSettled).toBe(false);
        if (interruption === "service") {
          stopping = workerService.stop().then(() => {
            stopped = true;
          });
          await workerService.reconcileOnce();
          await Promise.resolve();
          expect(stopped).toBe(false);
        }
      } finally {
        finishProducer.resolve();
        await reconciled;
        resetGatewayWorkAdmission();
        await (stopping ?? workerService.stop());
      }
      expect(producerSettled).toBe(true);
      if (interruption === "service") {
        expect(stopped).toBe(true);
      }
      expect(destroy).not.toHaveBeenCalled();
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: initial.state,
        leaseId: initial.leaseId,
        ownerEpoch: initial.ownerEpoch,
        provisionOperationId: initial.provisionOperationId,
        destroyRequestedAtMs: null,
        lastError: initial.lastError,
      });
      await expect(
        workerService.createWithRequest({
          profileId: "development",
          idempotencyKey: "request-after-stop",
        }),
      ).rejects.toMatchObject({
        code: "invalid_state",
      } satisfies Partial<WorkerEnvironmentServiceError>);
      await expect(workerService.destroy(environmentId)).rejects.toMatchObject({
        code: "invalid_state",
      } satisfies Partial<WorkerEnvironmentServiceError>);
    },
  );
});
