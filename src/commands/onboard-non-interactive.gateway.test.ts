// Non-interactive gateway onboarding tests cover local/remote setup, daemon install, and config writes.
// Gateway credential storage and health probes share the gateway-health-auth suite.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewaySshRemotePort } from "../gateway/connection-details.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  capturedReplaceConfigFileCalls,
  configWritePluginLeaseDepths,
  ensureWorkspaceAndSessionsMock,
  gatewayReachableState,
  gatewayServiceMock,
  healthCommandMock,
  installGatewayDaemonNonInteractiveMock,
  gatewayOnboardConfigSnapshotMock as readConfigFileSnapshotMock,
  readLastGatewayErrorLineMock,
  readTestConfig,
  resolveTestConfigPath,
  runNonInteractiveSetup,
  gatewayOnboardRuntime as runtime,
  testConfigStore,
  useGatewayOnboardTestHarness,
  waitForGatewayReachableMock,
} from "./onboard-non-interactive.gateway.test-mocks.js";
import {
  createOnboardJsonCaptureRuntime,
  createOnboardLocalDaemonOptions,
  expectOnboardLocalJsonSetupFailure,
} from "./onboard-non-interactive.test-helpers.js";
import type { OnboardOptions } from "./onboard-types.js";

const localDefaults = {
  nonInteractive: true,
  mode: "local",
  authChoice: "skip",
  skipSkills: true,
  skipHealth: true,
  installDaemon: false,
} as const;
const localOptions = (stateDir: string) => ({
  ...localDefaults,
  workspace: path.join(stateDir, "openclaw"),
});
const setupLocal = (stateDir: string, opts: Partial<OnboardOptions> = {}, env = runtime) =>
  runNonInteractiveSetup({ ...localOptions(stateDir), ...opts }, env);
const makeAgents = () => ({ alpha: { model: "fixture/alpha" }, beta: { model: "fixture/beta" } });
const routeBinding = (agentId: string, id: string) => ({
  type: "route" as const,
  agentId,
  match: { channel: "discord", peer: { kind: "direct" as const, id } },
});
type FailureOutput = {
  hints?: string[];
  daemonInstall?: { requested: boolean; installed: boolean; skippedReason?: string };
  diagnostics?: {
    service?: {
      loaded: boolean | null;
      loadState: { status: string; detail?: string };
    };
  };
};

describe("onboard (non-interactive): gateway and remote auth", () => {
  const { withStateDir } = useGatewayOnboardTestHarness("openclaw-onboard-");

  async function jsonFailure(
    stateDir: string,
    overrides: Partial<Parameters<typeof runNonInteractiveSetup>[0]> = {},
  ) {
    const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
    await expectOnboardLocalJsonSetupFailure({
      runSetup: (opts, runtimeEnv) => runNonInteractiveSetup({ ...opts, ...overrides }, runtimeEnv),
      stateDir,
      runtime: runtimeWithCapture,
    });
    return { parsed: JSON.parse(readCapturedJson()) as FailureOutput, output: readCapturedJson() };
  }

  async function captureFailure(
    stateDir: string,
    json: boolean,
    opts: Partial<OnboardOptions> = {},
  ) {
    const output = vi.fn();
    await expect(
      runNonInteractiveSetup(
        { ...createOnboardLocalDaemonOptions(stateDir), ...opts, json },
        {
          ...runtime,
          log: output,
          error: output,
          exit: () => {
            throw new Error("exit:1");
          },
        },
      ),
    ).rejects.toThrow("exit:1");
    return String(output.mock.calls.at(-1)?.[0]);
  }

  afterEach(async () => {
    gatewayReachableState.mock = undefined;
    const { resetSecretRedactionRegistryForTest } =
      await import("../logging/secret-redaction-registry.test-support.js");
    resetSecretRedactionRegistryForTest();
    testConfigStore.clear();
    capturedReplaceConfigFileCalls.length = 0;
    configWritePluginLeaseDepths.length = 0;
    vi.clearAllMocks();
  });

  it("uses the setup phase's Fix hint in human and JSON output", async () => {
    for (const json of [false, true]) {
      await withStateDir("state-phase-recovery-", async (stateDir) => {
        gatewayReachableState.mock = vi.fn(async () => ({
          ok: false,
          detail: "connect ECONNREFUSED 127.0.0.1:18997",
        }));
        const emitted = await captureFailure(stateDir, json, { installDaemon: undefined });
        const hints = json
          ? (JSON.parse(emitted) as { hints: string[] }).hints
          : emitted.split("\n");
        expect(hints.filter((hint) => hint.startsWith("Fix:"))).toEqual([
          "Fix: start `openclaw gateway run`, re-run `openclaw onboard --install-daemon`, or use `openclaw onboard --skip-health`.",
        ]);
        if (json) {
          expect(JSON.parse(emitted)).toMatchObject({
            ok: false,
            error: {
              type: "cli_error",
              message: expect.stringContaining("Gateway did not become reachable"),
            },
            phase: "gateway-health",
            classification: "not-listening",
          });
        }
      });
    }
  });

  it("keeps container precedence on every recovery command in human and JSON output", async () => {
    const env = { OPENCLAW_PROFILE: "work", OPENCLAW_CONTAINER_HINT: "preview" };
    const cases = [
      {
        detail: "unauthorized: invalid token",
        commands: ["doctor --fix"],
        json: false,
      },
      {
        detail: "Cannot find module sqlite-vec",
        commands: ["doctor --fix"],
      },
      {
        detail: "connect ECONNREFUSED",
        lastError: "Cannot find package '@openclaw/example' imported from /app/plugin.mjs",
        commands: ["doctor --fix"],
      },
      {
        detail: "connect ECONNREFUSED",
        loaded: false,
        commands: ["gateway install --force"],
      },
      {
        detail: "connect ECONNREFUSED",
        runtimeStatus: "stopped",
        commands: ["gateway restart"],
      },
      {
        detail: "startup timed out",
        lastError: "configuration parse failed",
        commands: ["gateway status --deep"],
      },
      {
        detail: "connect ECONNREFUSED",
        commands: ["gateway run", "gateway restart"],
      },
    ];

    await withEnvAsync(env, async () => {
      for (const { detail, loaded, runtimeStatus, lastError, commands, json = true } of cases) {
        await withStateDir("state-container-recovery-", async (stateDir) => {
          gatewayReachableState.mock = vi.fn(async () => ({ ok: false, detail }));
          gatewayServiceMock.isLoaded.mockResolvedValueOnce(loaded ?? true);
          gatewayServiceMock.readRuntime.mockResolvedValueOnce({
            status: runtimeStatus ?? "running",
            state: "active",
            pid: 4242,
          });
          readLastGatewayErrorLineMock.mockResolvedValueOnce(lastError ?? "");
          const emitted = await captureFailure(stateDir, json);
          const hint = json
            ? (JSON.parse(emitted) as { hints: string[] }).hints[0]
            : emitted.split("\n").find((line) => line.startsWith("Fix:"));
          for (const command of commands) {
            expect(hint).toContain(`\`openclaw --container preview ${command}\``);
          }
        });
      }
    });
  });

  it("rejects invalid existing config without writes and reports JSON failure", async () => {
    await withStateDir("state-invalid-config-", async (stateDir) => {
      const snapshot = await readConfigFileSnapshotMock();
      readConfigFileSnapshotMock.mockResolvedValueOnce({
        ...snapshot,
        exists: true,
        valid: false,
        issues: [{ path: "gateway.port", message: "invalid" }],
      });
      const output = vi.fn();
      const error = vi.fn();
      const message =
        "Config invalid. Run `openclaw doctor --fix` to apply supported repairs, then re-run setup.";

      await expect(
        setupLocal(
          stateDir,
          { json: true, gatewayBind: "loopback" },
          {
            log: output,
            error,
            exit: (code) => {
              throw new Error(`exit:${code}`);
            },
          },
        ),
      ).rejects.toThrow("exit:1");

      expect(error).toHaveBeenCalledWith(message);
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: { type: "cli_error", message },
        phase: "options",
        message,
      });
      expect(capturedReplaceConfigFileCalls).toHaveLength(0);
      expect(ensureWorkspaceAndSessionsMock).not.toHaveBeenCalled();
    });
  });

  it("rejects concurrent onboarding runs sharing one state directory", async () => {
    await withStateDir("state-concurrent-onboard-", async (stateDir) => {
      let workspaceSetupCalls = 0;
      let releaseFirstSetup!: () => void;
      const firstSetupEntered = new Promise<void>((resolve) => {
        ensureWorkspaceAndSessionsMock.mockImplementation(async () => {
          workspaceSetupCalls += 1;
          if (workspaceSetupCalls === 1) {
            resolve();
            await new Promise<void>((release) => {
              releaseFirstSetup = release;
            });
          }
        });
      });
      const options = localOptions(stateDir);

      try {
        const first = runNonInteractiveSetup(options, runtime);
        await firstSetupEntered;
        const readsBeforeSecond = readConfigFileSnapshotMock.mock.calls.length;
        const writesBeforeSecond = capturedReplaceConfigFileCalls.length;
        await expect(runNonInteractiveSetup(options, runtime)).rejects.toMatchObject({
          name: "SetupTargetLockedError",
        });

        expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(readsBeforeSecond);
        expect(capturedReplaceConfigFileCalls).toHaveLength(writesBeforeSecond);
        expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledOnce();

        releaseFirstSetup();
        await first;
        await runNonInteractiveSetup(options, runtime);
        expect(configWritePluginLeaseDepths).toHaveLength(2);
        expect(configWritePluginLeaseDepths.every((depth) => depth > 0)).toBe(true);
      } finally {
        releaseFirstSetup?.();
        ensureWorkspaceAndSessionsMock.mockImplementation(async () => {});
      }
    });
  });

  it("migrates local onboard plugin install records in the setup write", async () => {
    await withStateDir("state-local-plugin-installs-", async (stateDir) => {
      testConfigStore.set(resolveTestConfigPath(), {
        plugins: {
          installs: {
            demo: {
              source: "path",
              installPath: path.join(stateDir, "plugins", "demo"),
            },
          },
        },
      } as OpenClawConfig);

      await setupLocal(stateDir, {
        gatewayBind: "loopback",
        gatewayAuth: "token",
        gatewayToken: "tok_plugin_installs",
      });

      expect(capturedReplaceConfigFileCalls).toHaveLength(1);
      const onboardWrite = capturedReplaceConfigFileCalls.at(-1);
      expect(onboardWrite?.nextConfig.plugins?.installs).toBeUndefined();
      expect(onboardWrite?.writeOptions?.unsetPaths).toEqual([["plugins", "installs"]]);
      expect(onboardWrite?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
  }, 60_000);

  const remoteCredentialUrl = "wss://gateway.example.test";
  const remoteTokenRef = { source: "env", provider: "default", id: "OLD_REMOTE_TOKEN" } as const;
  const remoteTlsFingerprint = "sha256:test-fingerprint";
  const remoteEdgeAuth = { "X-Edge-Auth": "existing-edge-secret" };
  const remoteCredentialConfig = (
    remote: NonNullable<OpenClawConfig["gateway"]>["remote"],
  ): OpenClawConfig => ({ gateway: { mode: "remote", remote } });

  async function setupRemoteConfig(opts: Partial<OnboardOptions>, baseConfig: OpenClawConfig) {
    let config: OpenClawConfig = {};
    await withStateDir("state-remote-credentials-", async () => {
      testConfigStore.set(resolveTestConfigPath(), baseConfig);
      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "remote",
          remoteUrl: remoteCredentialUrl,
          skipHooks: true,
          ...opts,
        },
        runtime,
      );
      config = readTestConfig();
      expect(config.gateway?.mode).toBe("remote");
      expect(config.hooks).toEqual(baseConfig.hooks);
      expect(capturedReplaceConfigFileCalls.at(-1)?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
    return config;
  }

  const setupRemoteCredentials = async (opts: Partial<OnboardOptions>, config: OpenClawConfig) =>
    (await setupRemoteConfig(opts, config)).gateway?.remote;

  it.each([
    {
      name: "fresh remote configuration",
      baseConfig: {},
      expectedRemote: { url: remoteCredentialUrl, password: "replacement-password" },
    },
    {
      name: "a token SecretRef on the same endpoint",
      baseConfig: remoteCredentialConfig({
        url: remoteCredentialUrl,
        token: remoteTokenRef,
        tlsFingerprint: remoteTlsFingerprint,
        edgeAuth: remoteEdgeAuth,
      }),
      expectedRemote: {
        url: remoteCredentialUrl,
        password: "replacement-password",
        tlsFingerprint: remoteTlsFingerprint,
        edgeAuth: remoteEdgeAuth,
      },
    },
    {
      name: "credentials and routing from a different endpoint",
      baseConfig: remoteCredentialConfig({
        url: "wss://old-gateway.example.test",
        token: remoteTokenRef,
        password: { source: "env", provider: "default", id: "OLD_REMOTE_PASSWORD" },
        tlsFingerprint: "sha256:old-fingerprint",
        sshTarget: "operator@old-gateway.example.test",
        remotePort: 24680,
        sshIdentity: "/tmp/old-identity",
        sshHostKeyPolicy: "openssh",
        edgeAuth: { "X-Edge-Auth": "old-edge-secret" },
      }),
      expectedRemote: { url: remoteCredentialUrl, password: "replacement-password" },
    },
  ])("stores a remote password while replacing $name", async ({ baseConfig, expectedRemote }) => {
    expect(
      await setupRemoteCredentials({ remotePassword: "replacement-password" }, baseConfig),
    ).toEqual(expectedRemote);
  });

  it.each([
    ["remoteToken", "token", "OPENCLAW_GATEWAY_TOKEN", "password"],
    ["remotePassword", "password", "OPENCLAW_GATEWAY_PASSWORD", "token"],
  ] as const)(
    "stores %s as a configured-provider env reference and clears the old credential",
    async (option, field, envName, previousField) => {
      await withEnvAsync({ [envName]: "replacement-credential" }, async () => {
        const remote = await setupRemoteCredentials(
          { [option]: "replacement-credential", secretInputMode: "ref" },
          {
            secrets: {
              defaults: { env: "gatewayenv" },
              providers: { gatewayenv: { source: "env" } },
            },
            ...remoteCredentialConfig({
              url: remoteCredentialUrl,
              [previousField]: { source: "env", provider: "default", id: "OLD_GATEWAY_CREDENTIAL" },
              tlsFingerprint: remoteTlsFingerprint,
            }),
          },
        );
        expect(remote).toEqual({
          url: remoteCredentialUrl,
          [field]: { source: "env", provider: "gatewayenv", id: envName },
          tlsFingerprint: remoteTlsFingerprint,
        });
      });
    },
  );

  it("clears a stale remote password when a token replaces auth for the same endpoint", async () => {
    const remote = await setupRemoteCredentials(
      { remoteToken: "replacement-token" },
      remoteCredentialConfig({
        url: remoteCredentialUrl,
        password: "old-password",
        tlsFingerprint: remoteTlsFingerprint,
      }),
    );
    expect(remote).toEqual({
      url: remoteCredentialUrl,
      token: "replacement-token",
      tlsFingerprint: remoteTlsFingerprint,
    });
  });

  it.each([
    [remoteCredentialUrl, "existing-password"],
    [remoteCredentialUrl, { source: "env", provider: "default", id: "EXISTING_REMOTE_PASSWORD" }],
    [
      `${remoteCredentialUrl}/`,
      { source: "env", provider: "default", id: "EXISTING_REMOTE_PASSWORD" },
    ],
  ] as const)(
    "preserves remote credentials and fleet from %s without a replacement (openclaw#84692)",
    async (url, password) => {
      const remote = {
        url,
        token: typeof password === "string" ? "existing-token" : remoteTokenRef,
        password,
        tlsFingerprint: remoteTlsFingerprint,
        transport: "ssh" as const,
        sshTarget: "operator@gateway.example.test",
      };
      const baseConfig: OpenClawConfig = {
        ...remoteCredentialConfig(remote),
        agents: { ownership: "explicit", entries: makeAgents() },
        bindings: [routeBinding("alpha", "user-1")],
        hooks: { internal: { enabled: false, entries: { "session-memory": { enabled: false } } } },
      };
      const config = await setupRemoteConfig(
        { secretInputMode: "ref", authChoice: "skip", json: true },
        baseConfig,
      );
      expect(config.gateway?.remote).toEqual({ ...remote, url: remoteCredentialUrl });
      expect(config.agents).toEqual(baseConfig.agents);
      expect(config.bindings).toEqual(baseConfig.bindings);
    },
  );

  it.each([
    ["ws://127.0.0.1:80", "ws://127.0.0.1", 80],
    ["ws://127.0.0.1", "ws://127.0.0.1:80", 18789],
  ] as const)(
    "preserves the SSH destination when editing %s to %s",
    async (originalUrl, url, port) => {
      const remote = await setupRemoteCredentials(
        { remoteUrl: url },
        {
          gateway: {
            port: 18789,
            remote: {
              url: originalUrl,
              transport: "ssh",
              sshTarget: "operator@gateway.example.test",
              token: "existing-token",
            },
          },
        },
      );
      expect(remote).toMatchObject({
        url,
        sshTarget: "operator@gateway.example.test",
        token: "existing-token",
      });
      expect(resolveGatewaySshRemotePort({ gateway: { port: 18789, remote } })).toBe(port);
    },
  );

  it("clears credentials and transport trust when the remote query changes", async () => {
    const url = `${remoteCredentialUrl}?account=work`;
    const remote = await setupRemoteCredentials(
      { remoteUrl: url },
      remoteCredentialConfig({
        url: remoteCredentialUrl,
        token: remoteTokenRef,
        password: "existing-password",
        transport: "ssh",
        sshTarget: "operator@gateway.example.test",
        tlsFingerprint: remoteTlsFingerprint,
      }),
    );
    expect(remote).toEqual({ url });
  });

  it("completes explicit no-daemon setup without a startup wait when no gateway is listening", async () => {
    await withStateDir("state-local-health-hint-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      const log = vi.fn();

      await runNonInteractiveSetup(
        { ...createOnboardLocalDaemonOptions(stateDir), installDaemon: false },
        { ...runtime, log },
      );

      expect(log.mock.calls.flat().join("\n")).toMatch(
        /Setup complete; gateway was not installed or started because daemon installation was explicitly skipped\.[\s\S]*Gateway did not become reachable[\s\S]*Classification: not-listening[\s\S]*only waits for an already-running gateway unless you pass `--install-daemon` to `openclaw onboard`[\s\S]*openclaw onboard --install-daemon[\s\S]*openclaw onboard --skip-health/,
      );
      expect(gatewayReachableState.mock).toHaveBeenCalledOnce();
      expect(waitForGatewayReachableMock).not.toHaveBeenCalled();
    });
  }, 60_000);

  it("allows extended health checks for a managed Windows daemon", async () => {
    await withStateDir("state-local-daemon-health-", async (stateDir) => {
      // Bootstrap shared/client state and runtime pins before spoofing daemon timing.
      const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
      openOpenClawStateDatabase({ env: process.env });
      const { initializeFreshDaemonRuntimePinMigration } =
        await import("../infra/state-migrations.daemon-runtime-pins.js");
      initializeFreshDaemonRuntimePinMigration(process.env);
      gatewayReachableState.mock = vi.fn(async () => ({ ok: true }));

      await withMockedPlatform("win32", () =>
        runNonInteractiveSetup(createOnboardLocalDaemonOptions(stateDir), runtime),
      );

      expect(healthCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 90_000 }),
        expect.anything(),
      );
    });
  }, 60_000);

  it("emits a daemon-install failure even when health checks are skipped", async () => {
    await withStateDir("state-local-daemon-install-json-fail-", async (stateDir) => {
      installGatewayDaemonNonInteractiveMock.mockResolvedValueOnce({
        installed: false,
        skippedReason: "systemd-user-unavailable",
      });

      const { parsed } = await withMockedPlatform("linux", () =>
        jsonFailure(stateDir, { skipHealth: true }),
      );
      expect(parsed).toMatchObject({ ok: false, phase: "daemon-install" });
      expect(parsed.daemonInstall).toEqual({
        requested: true,
        installed: false,
        skippedReason: "systemd-user-unavailable",
      });
      expect(parsed.hints).toContain(
        "Fix: rerun without `--install-daemon` for one-shot setup, or enable a working user-systemd session and retry.",
      );
    });
  }, 60_000);

  it("emits structured JSON diagnostics when daemon health fails", async () => {
    await withStateDir("state-local-daemon-health-json-fail-", async (stateDir) => {
      const registeredSecret = "qa-onboarding-health-secret";
      const { registerSecretValueForRedaction } =
        await import("../logging/secret-redaction-registry.js");
      registerSecretValueForRedaction(registeredSecret);
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: `gateway closed (1006 abnormal closure (no close frame)): ${registeredSecret}`,
      }));
      readLastGatewayErrorLineMock.mockResolvedValueOnce(
        `Gateway failed to start: required secrets are unavailable: ${registeredSecret}`,
      );

      const { parsed, output } = await jsonFailure(stateDir);
      expect(parsed).toMatchObject({
        ok: false,
        phase: "gateway-health",
        installDaemon: true,
        detail: expect.stringContaining("1006 abnormal closure"),
        gateway: { wsUrl: expect.stringContaining("ws://127.0.0.1:") },
        diagnostics: {
          service: { label: "LaunchAgent", loaded: true, runtimeStatus: "running", pid: 4242 },
          lastGatewayError: expect.stringContaining("required secrets are unavailable"),
        },
      });
      expect(parsed.hints).toContain("Run `openclaw gateway status --deep` for more detail.");
      expect(parsed.diagnostics?.service?.loadState).toEqual({ status: "loaded" });
      expect(output).not.toContain(registeredSecret);
    });
  }, 60_000);

  it("emits structured JSON failure when a reachable managed gateway fails its health check", async () => {
    await withStateDir("state-local-daemon-health-exit-json-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({ ok: true }));
      healthCommandMock.mockImplementationOnce(async (...args: unknown[]) => {
        // healthCommand prints its reachable-gateway diagnostic before its
        // CLI-style exit; the capture runtime must keep it off JSON stdout.
        // importActual yields the ExitError instance the prod graph sees; the
        // test file's static import can be a second class instance under Vitest.
        const { ExitError: RuntimeExitError } =
          await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
        const healthRuntime = args[1] as RuntimeEnv;
        healthRuntime.log("Gateway is reachable.");
        healthRuntime.log("Gateway credentials rejected.");
        throw new RuntimeExitError(1);
      });

      const { parsed } = await jsonFailure(stateDir);
      expect(parsed).toMatchObject({
        ok: false,
        phase: "gateway-health",
        message: expect.stringContaining("health check failed"),
        detail: expect.stringContaining("Gateway credentials rejected."),
      });
      expect(parsed.hints).toContain("Run `openclaw health` for full diagnostics.");
    });
  }, 60_000);

  it("routes thrown health-check errors through the onboarding failure owner", async () => {
    await withStateDir("state-local-health-failure-text-", async (stateDir) => {
      const registeredSecret = "qa-onboarding-health-secret";
      const { registerSecretValueForRedaction } =
        await import("../logging/secret-redaction-registry.js");
      registerSecretValueForRedaction(registeredSecret);
      gatewayReachableState.mock = vi.fn(async () => ({ ok: true }));
      healthCommandMock.mockRejectedValueOnce(
        new Error(`health request timed out: ${registeredSecret}`),
      );

      const failure = await runNonInteractiveSetup(
        createOnboardLocalDaemonOptions(stateDir),
        runtime,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/health check failed[\s\S]*health request timed out/);
      expect(String(failure)).not.toContain(registeredSecret);
    });
  }, 60_000);

  it("preserves unknown service inspection in JSON diagnostics", async () => {
    await withStateDir("state-local-daemon-health-unknown-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      gatewayServiceMock.isLoaded.mockRejectedValueOnce(new Error("systemctl timed out"));

      const { parsed } = await jsonFailure(stateDir);
      expect(parsed.diagnostics?.service?.loaded).toBeNull();
      expect(parsed.diagnostics?.service?.loadState).toEqual({
        status: "unknown",
        detail: "Error: systemctl timed out",
      });
    });
  }, 60_000);
});
