import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { setLoggerOverride } from "../../logging/logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createApiKeyCredential,
  createAuthProfileUsageStore as makeStore,
} from "./credential-fixtures.test-support.js";
import {
  markOAuthRefreshFailureSettled,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";
import { createFailedOAuthRefreshFence, createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import * as oauth from "./oauth.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import {
  mockLockedUpdateForStore,
  mockLockedUpdatesForStore,
  resetAuthProfileUsageMocks,
  storeMocks,
  usageMocks,
} from "./usage-fixture.test-support.js";
import {
  isProfileInCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileFailure,
  maybeReprobeWhamBlockedProfiles,
  reconcileAuthProfileQuotaBlocks,
} from "./usage.js";
import { testing as authProfileUsageTesting } from "./usage.test-support.js";

const codexId = "openai:default";
const anthropicId = "anthropic:default";
const copilotId = "github-copilot:github";
const testNow = 1_700_000_000_000;
type FailureReason = Parameters<typeof markAuthProfileFailure>[0]["reason"];
type FailureOptions = Partial<Parameters<typeof markAuthProfileFailure>[0]>;
const codexStore = (stats?: ProfileUsageStats) =>
  makeStore(stats === undefined ? undefined : { [codexId]: stats });
const blockedStats = (now: number): ProfileUsageStats => ({
  blockedUntil: now + 86_400_000,
  blockedReason: "subscription_limit",
  blockedSource: "wham",
});
function oauthProfile(store: AuthProfileStore, profileId = codexId) {
  const profile = store.profiles[profileId];
  if (profile?.type !== "oauth") {
    throw new Error("expected OAuth fixture");
  }
  return profile;
}
function resolvedCredential(credential: ReturnType<typeof oauthProfile>, profileId = codexId) {
  return {
    apiKey: credential.access,
    provider: "openai",
    profileId,
    profileType: "oauth" as const,
    credential,
    readCurrentCredential: null,
  };
}
const whamWindow = (used_percent: number, reset_after_seconds: number) => ({
  used_percent,
  reset_after_seconds,
});
const whamResponse = (
  limit_reached: boolean,
  primary_window?: ReturnType<typeof whamWindow>,
  secondary_window?: ReturnType<typeof whamWindow>,
) => ({
  rate_limit: { limit_reached, primary_window, secondary_window },
});
function expiredQuota(now: number, stats = blockedStats(now)) {
  const store = codexStore(stats);
  mockLockedUpdatesForStore(store);
  const profile = oauthProfile(store);
  const expires = profile.expires;
  profile.expires = now - 1;
  return {
    store,
    profile,
    expires,
    refreshed: { ...profile, access: "refreshed-access", expires: now + 3_600_000 },
  };
}
const expectStats = (store: AuthProfileStore, stats: ProfileUsageStats, profileId = codexId) =>
  expect(store.usageStats?.[profileId]).toMatchObject(stats);
function reprobe(
  store: AuthProfileStore,
  options: Partial<Omit<Parameters<typeof maybeReprobeWhamBlockedProfiles>[0], "store">> = {},
) {
  return maybeReprobeWhamBlockedProfiles({
    profileIds: [codexId],
    agentDir: "/tmp/quota-owner",
    ...options,
    store,
  });
}
const fetchMock = vi.hoisted(() => vi.fn());
const resolveApiKeyForProfileMock = vi.hoisted(() =>
  vi.fn<typeof import("./oauth.js").resolveApiKeyForProfile>(),
);

let resolveApiKeyForProfileSpy: MockInstance<typeof oauth.resolveApiKeyForProfile> | undefined;

// mock-isolation: Exercise quota planning and the real reducer without persistence workers.
vi.mock("./usage-write.js", async () => ({
  withAuthProfileUsage: (await import("./usage-fixture.test-support.js")).usageMocks
    .withAuthProfileUsage,
}));
// mock-isolation: Keep native auth-store I/O outside the in-memory quota fixture.
vi.mock(
  "./store-runtime.js",
  async () => (await import("./usage-fixture.test-support.js")).storeMocks,
);

beforeEach(() => {
  for (const mock of [...Object.values(storeMocks), fetchMock, resolveApiKeyForProfileMock]) {
    mock.mockReset();
  }
  storeMocks.resolvePersistedAuthProfileOwnerAgentDirAsync.mockImplementation(
    async (params: { agentDir?: string }) => params.agentDir,
  );
  resetAuthProfileUsageMocks();
  // Vitest can bypass manual factories during concurrent lazy imports. Keep both
  // quota operations on the same mocked export without serializing their work.
  resolveApiKeyForProfileSpy = vi
    .spyOn(oauth, "resolveApiKeyForProfile")
    .mockImplementation(resolveApiKeyForProfileMock);
  vi.stubGlobal("fetch", fetchMock);
  storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue({ version: 1, profiles: {} });
});

afterEach(() => {
  resolveApiKeyForProfileSpy?.mockRestore();
  resolveApiKeyForProfileSpy = undefined;
  authProfileUsageTesting.resetWhamReprobeStateForTest();
  vi.unstubAllGlobals();
});

async function atTime(time: number, run: () => Promise<void>) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(time);
  try {
    await run();
  } finally {
    clock.mockRestore();
  }
}
async function markFailureAt(
  store: AuthProfileStore,
  reason: FailureReason,
  time = testNow,
  options: FailureOptions = {},
) {
  await atTime(time, () =>
    markAuthProfileFailure({ store, profileId: anthropicId, reason, ...options }),
  );
}

describe("failure retry windows (#23516)", () => {
  it.each([0, Infinity, Number.MAX_SAFE_INTEGER])(
    "ignores invalid provider timing %s",
    async (retryAfterMs) => {
      const store = makeStore(undefined);
      await markFailureAt(store, "rate_limit", testNow, { retryAfterMs });
      expect(store.usageStats?.[anthropicId]).toEqual({
        lastRateLimitAt: testNow,
      });
    },
  );

  it("recomputes expired disabledUntil on retry", async () => {
    const now = 1_000_000;
    const store = makeStore({
      [anthropicId]: {
        disabledUntil: now - 60_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 2 },
        lastFailureAt: now - 60_000,
      },
    });
    await markFailureAt(store, "billing", now);
    expect(store.usageStats?.[anthropicId]?.disabledUntil).toBe(now + 10 * 60 * 1000);
  });

  it.each([
    ["cooldownUntil", "timeout"],
    ["disabledUntil", "billing"],
  ] as const)("keeps recomputed %s inside the valid Date range", async (field, reason) => {
    const store = makeStore({});
    await markFailureAt(store, reason, MAX_DATE_TIMESTAMP_MS);
    expect(store.usageStats?.[anthropicId]?.[field]).toBe(MAX_DATE_TIMESTAMP_MS);
  });
});

describe("markAuthProfileBlockedUntil", () => {
  const model = "gpt-5.4";
  const sibling = "gpt-5.4-mini";
  it.each([
    ["same model stays scoped", false, model, model],
    ["different model widens", false, sibling, undefined],
    ["profile-wide never narrows", true, model, undefined],
  ] as const)("%s", async (_name, wide, incomingModel, expectedModel) => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const store = codexStore({
      blockedUntil: now + (wide ? 120_000 : 60_000),
      ...(!wide ? { blockedModel: model, blockedScope: "model" as const } : {}),
      cooldownClassification: "wham_token_expired",
    });
    mockLockedUpdateForStore(store);
    await atTime(now, () =>
      markAuthProfileBlockedUntil({
        store,
        profileId: codexId,
        blockedUntil: now + (wide ? 60_000 : 120_000),
        source: "codex_rate_limits",
        modelId: incomingModel,
      }),
    );
    expectStats(store, {
      blockedModel: expectedModel,
      blockedScope: expectedModel ? "model" : undefined,
      lastRateLimitAt: now,
      ...(wide ? { blockedUntil: now + 120_000 } : {}),
      cooldownClassification: undefined,
    });
  });

  it("ignores blocked-until updates outside the valid Date range", async () => {
    const store = makeStore({});
    mockLockedUpdateForStore(store);
    await markAuthProfileBlockedUntil({
      store,
      profileId: codexId,
      blockedUntil: Number.MAX_SAFE_INTEGER,
      source: "codex_rate_limits",
    });
    expect(store.usageStats).toEqual({});
  });
});

it("does not persist unverifiable failures for API-key profiles", async () => {
  const store = makeStore(undefined);
  store.profiles["azure-foundry:default"] = createApiKeyCredential("azure-foundry", "test-key");

  for (const profileId of ["azure-foundry:default", "openai:api-key"]) {
    await markAuthProfileFailure({ store, profileId, reason: "no_error_details" });
  }

  expect(store.usageStats).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("drops bookkeeping without an unlocked full-store save", async () => {
  const store = makeStore(undefined);
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  usageMocks.record.mockResolvedValueOnce(null);
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  try {
    await markAuthProfileFailure({ store, profileId: anthropicId, reason: "rate_limit" });
    expect(store.usageStats).toBeUndefined();
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();
  } finally {
    setLoggerOverride(null);
    consoleWarn.mockRestore();
  }
});

describe("markAuthProfileFailure — WHAM-aware Codex cooldowns", () => {
  function mockWhamResponse(status: number, body?: unknown): void {
    fetchMock.mockResolvedValueOnce(
      new Response(body === undefined ? "{}" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  async function markCodexFailureAt(params: FailureOptions & { mockLock?: boolean } = {}) {
    const { store = makeStore({}), mockLock = true, ...options } = params;
    storeMocks.loadAuthProfileStoreWithoutExternalProfilesAsync.mockResolvedValue(store);
    if (mockLock) {
      mockLockedUpdateForStore(store);
    }
    await markFailureAt(store, "rate_limit", testNow, { profileId: codexId, ...options });
    return store;
  }

  it.each([true, false])(
    "shares expired-credential recovery and waits for quota capacity (available: %s)",
    async (available) => {
      const now = Date.now();
      const { store, refreshed } = expiredQuota(now);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      resolveApiKeyForProfileMock.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        store.profiles[codexId] = refreshed;
        return resolvedCredential(refreshed, codexId);
      });
      mockWhamResponse(
        200,
        available ? whamResponse(false) : whamResponse(true, whamWindow(100, 3600)),
      );
      const probes = [reprobe(store, { cfg: {} }), reprobe(store, { cfg: {} })];
      try {
        await Promise.race([entered.promise, Promise.all(probes)]);
        expect(resolveApiKeyForProfileMock).toHaveBeenCalledOnce();
        expect(resolveApiKeyForProfileMock).toHaveBeenCalledWith(
          expect.objectContaining({ allowProfileFallback: false }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.usageStats?.[codexId]?.blockedUntil).toBe(now + 86_400_000);
      } finally {
        release.resolve();
        await Promise.all(probes);
      }
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
        Authorization: "Bearer refreshed-access",
        "ChatGPT-Account-Id": "acct_test_123",
      });
      expect(oauthProfile(store).access).toBe(refreshed.access);
      if (available) {
        expect(store.usageStats?.[codexId]?.blockedUntil).toBeUndefined();
      } else {
        expect(store.usageStats?.[codexId]?.blockedReason).toBe("subscription_limit");
        expect(store.usageStats?.[codexId]?.blockedUntil).toBeGreaterThan(now);
      }
    },
  );

  it("keeps a healthy caller-selected profile omitted from auth order after another refresh fails", async () => {
    const now = Date.now();
    const { store, profile, expires } = expiredQuota(now);
    store.profiles["openai:healthy"] = { ...profile, access: "healthy-access", expires };
    const failure = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: codexId,
      message: "refresh rejected",
    });
    markOAuthRefreshFailureSettled(failure);
    resolveApiKeyForProfileMock.mockRejectedValueOnce(failure);
    await reprobe(store, {
      profileIds: [codexId, "openai:healthy"],
      cfg: { auth: { order: { openai: [codexId] } } },
    });
    expect(isProfileInCooldown(store, "openai:healthy")).toBe(false);
    expect(isProfileInCooldown(store, "openai:default")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("joins peer quota work before surfacing an unclassified refresh failure", async () => {
    const now = Date.now();
    const { store, profile } = expiredQuota(now);
    store.usageStats!["openai:peer"] = blockedStats(now);
    store.profiles["openai:peer"] = { ...profile };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new OAuthRefreshFailureError({
      provider: "openai",
      message: "refresh failed",
      cause: Object.assign(new Error("disk I/O error"), { errcode: 778 }),
    });
    resolveApiKeyForProfileMock.mockImplementation(async ({ profileId }) => {
      if (profileId === "openai:default") {
        throw failure;
      }
      entered.resolve();
      await release.promise;
      const refreshed = { ...profile, access: "peer-access", expires: now + 3_600_000 };
      store.profiles[profileId] = refreshed;
      return resolvedCredential(refreshed, profileId);
    });
    mockWhamResponse(200, whamResponse(false));
    let settled = false;
    const probe = reprobe(store, { profileIds: [codexId, "openai:peer"] });
    const observation = probe
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    try {
      await Promise.race([entered.promise, observation]);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await observation;
    }
    await expect(probe).rejects.toBe(failure);
    expect(store.usageStats?.["openai:peer"]?.blockedUntil).toBeUndefined();
  });

  it.each([
    "replaced credential",
    "removed credential",
    "settled error",
    "unclassified error",
    "no credential",
  ] as const)("does not probe an unresolved credential recovery (%s)", async (outcome) => {
    const now = Date.now();
    const profileId = codexId;
    const { store, profile, refreshed } = expiredQuota(now);
    store.profiles = { [profileId]: profile };
    const failure = new OAuthRefreshFailureError({
      provider: "openai",
      profileId,
      message: "refresh failed",
    });
    if (outcome === "settled error") {
      markOAuthRefreshFailureSettled(failure);
    }
    resolveApiKeyForProfileMock.mockImplementationOnce(async () => {
      if (outcome === "removed credential" || outcome === "replaced credential") {
        if (outcome === "removed credential") {
          delete store.profiles[profileId];
        } else {
          store.profiles[profileId] = { ...refreshed, access: "replacement-access" };
        }
        return resolvedCredential(refreshed, profileId);
      }
      store.profiles[profileId] = createFailedOAuthRefreshFence(
        createOAuthRefreshFence({ profileId, credential: profile }),
      );
      if (outcome === "no credential") {
        return null;
      }
      throw failure;
    });
    const isError = outcome === "settled error" || outcome === "unclassified error";
    const reconciliation = isError
      ? reconcileAuthProfileQuotaBlocks({
          provider: "openai",
          modelId: "gpt-5.5",
          authProfileStore: store,
          agentDir: "/tmp/quota-owner",
        })
      : reprobe(store);
    if (outcome === "unclassified error") {
      await expect(reconciliation).rejects.toBe(failure);
      return;
    }
    const result = await reconciliation;
    expect(result).toEqual(
      outcome === "no credential" ? { requiresAuthPreparation: true } : undefined,
    );
    expect(resolveApiKeyForProfileMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.usageStats?.[profileId]?.blockedUntil).toBe(now + 86_400_000);
  });

  it("re-arms a stale WHAM block from the latest blocked snapshot", async () => {
    const now = testNow;
    prepareSharedAuthStoreOwnershipForNative();
    const store = codexStore({
      ...blockedStats(now),
      blockedUntil: now + 6 * 24 * 60 * 60 * 1000,
      blockedModel: "gpt-5.5",
      blockedScope: "model",
    });
    mockWhamResponse(200, whamResponse(true, whamWindow(100, 3_600)));
    mockLockedUpdatesForStore(store);
    await atTime(now, async () => {
      await reprobe(store, { forModel: "gpt-5.5", now, agentDir: undefined });
      await vi.waitFor(() => {
        expect(store.usageStats?.[codexId]?.blockedUntil).toBe(now + 3_600_000);
      });
    });
    expectStats(store, { lastProbeAt: now, blockedModel: "gpt-5.5", blockedScope: "model" });
  });

  const available = whamResponse(false, whamWindow(45, 9_000));
  it.each([
    ["fresh available quota", available, undefined, "fresh", undefined],
    ["provider Retry-After", available, 60_000, "fresh", 60_000],
    ["active provider window", available, 6 * 3_600_000, "cooldown", undefined],
    [
      "team rolling",
      whamResponse(true, whamWindow(100, 7_200), whamWindow(85, 201_600)),
      7_200_000,
      "blocked",
      undefined,
    ],
    [
      "team weekly",
      whamResponse(true, whamWindow(90, 7_200), whamWindow(100, 28_800)),
      28_800_000,
      "blocked",
      undefined,
    ],
  ] as const)("maps %s to cooldown", async (_name, response, expectedMs, state, retryAfterMs) => {
    const now = testNow;
    const store = codexStore(
      state === "fresh"
        ? undefined
        : {
            cooldownUntil: now + 6 * 60 * 60 * 1000,
            cooldownReason: "rate_limit",
            lastRateLimitAt: now - 1_000,
          },
    );
    mockWhamResponse(200, response);

    await markCodexFailureAt({ store, retryAfterMs });
    const stats = store.usageStats?.[codexId];
    expect(stats?.lastProbeAt).toBe(now);
    if (state === "blocked") {
      expect(stats?.blockedUntil).toBe(now + (expectedMs ?? 0));
      expect(stats?.blockedReason).toBe("subscription_limit");
      expect(stats?.cooldownUntil).toBeUndefined();
    } else {
      expect(stats?.cooldownUntil).toBe(expectedMs === undefined ? undefined : now + expectedMs);
      if (retryAfterMs) {
        expect(stats?.cooldownReason).toBe("rate_limit");
      }
    }
  });

  it("does not apply a stale WHAM result after the profile changes", async () => {
    const store = makeStore(undefined);
    mockWhamResponse(200, whamResponse(false, whamWindow(45, 9_000)));
    const freshStore = structuredClone(store);
    freshStore.profiles[codexId] = createApiKeyCredential("openai", "rotated-api-key");
    usageMocks.readFresh.mockReturnValueOnce(store).mockReturnValue(freshStore);

    await markCodexFailureAt({ store, reason: "no_error_details", mockLock: false });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.usageStats).toBeUndefined();
  });

  it.each([
    [401, 12, "auth", "wham_token_expired"],
    [403, 24, "auth_permanent", "wham_account_dead"],
  ] as const)(
    "persists WHAM HTTP %s auth classification and fallback reason",
    async (status, hours, reason, classification) => {
      const now = testNow;
      mockWhamResponse(status);
      const store = await markCodexFailureAt({ modelId: "gpt-5.6-luna" });
      expectStats(store, {
        cooldownUntil: now + hours * 3_600_000,
        cooldownReason: reason,
        cooldownClassification: classification,
        cooldownModel: undefined,
      });
    },
  );

  it.each(["chatgpt-token-sharing", "chatgpt-identity", "expired access"])(
    "excludes %s from failure quota probes",
    async (authFlow) => {
      const now = testNow;
      const store = codexStore({ cooldownClassification: "wham_token_expired" });
      const profile = oauthProfile(store, codexId);
      if (authFlow === "expired access") {
        profile.expires = now - 1;
      } else {
        profile.authFlow = authFlow;
      }
      mockWhamResponse(401);

      await markCodexFailureAt({ store, retryAfterMs: 30_000 });
      expect(fetchMock).not.toHaveBeenCalled();
      expectStats(store, {
        cooldownUntil: now + 30_000,
        cooldownReason: "rate_limit",
        cooldownClassification: undefined,
      });
      if (authFlow === "expired access") {
        return;
      }

      const block = blockedStats(now);
      store.usageStats = { [codexId]: { ...block } };
      await maybeReprobeWhamBlockedProfiles({ store, profileIds: [codexId], now });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.usageStats[codexId]).toEqual(block);
    },
  );

  it.each(["http", "network", "reset_after_seconds", "reset_at"] as const)(
    "falls back from an unusable WHAM %s response",
    async (failure) => {
      const response = new Response("server busy", { status: 500 });
      const cancel =
        failure === "http"
          ? vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined)
          : undefined;
      if (failure === "http") {
        fetchMock.mockResolvedValueOnce(response);
      } else if (failure === "network") {
        fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
      } else {
        mockWhamResponse(200, {
          rate_limit: {
            limit_reached: true,
            primary_window: { used_percent: 100, [failure]: Number.MAX_SAFE_INTEGER },
          },
        });
      }
      const reason = failure === "network" ? "unknown" : "rate_limit";
      const store = await markCodexFailureAt({ reason });
      const stats = store.usageStats?.[codexId];
      // A failed probe supplies no rate-limit deadline; other reasons keep local timing.
      expect(stats?.cooldownUntil).toBe(reason === "rate_limit" ? undefined : testNow + 30_000);
      expect(stats?.blockedUntil).toBeUndefined();
      expect(stats?.lastProbeAt).toBe(testNow);
      if (cancel) {
        expect(cancel).toHaveBeenCalledOnce();
      }
    },
  );
});

describe("markAuthProfileFailure — per-model cooldown metadata", () => {
  const now = 1_000_000;
  const sonnet = "claude-sonnet-4.6";
  const activeStats = (reason: FailureReason): ProfileUsageStats => ({
    cooldownUntil: now + 30_000,
    cooldownReason: reason,
    cooldownModel: sonnet,
    errorCount: 1,
    lastFailureAt: now - 1_000,
  });
  it.each([
    ["rate_limit", undefined, sonnet, sonnet, undefined],
    ["model_not_found", "model_not_found", sonnet, sonnet, now + 30_000],
    ["model_not_found", undefined, sonnet, sonnet, undefined], // #116464
    ["rate_limit", "rate_limit", "gpt-4.1", undefined, undefined],
    ["auth", "rate_limit", "claude-opus-4.6", undefined, undefined],
  ] as const)(
    "%s after %s on %s",
    async (reason, previousReason, modelId, expectedModel, until) => {
      const store = makeStore({ [copilotId]: previousReason ? activeStats(previousReason) : {} });
      store.profiles[copilotId] = createApiKeyCredential("github-copilot", "ghu_test");
      mockLockedUpdateForStore(store);
      await markFailureAt(store, reason, now, {
        profileId: copilotId,
        modelId,
        retryAfterMs: 30_000,
      });
      expect(store.usageStats?.[copilotId]).toMatchObject({
        cooldownReason: reason,
        cooldownModel: expectedModel,
        ...(until !== undefined ? { cooldownUntil: until } : {}),
      });
    },
  );
});
