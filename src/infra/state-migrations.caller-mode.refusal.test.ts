import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sharedAuthBootstrap from "../agents/auth-profiles/shared-store-bootstrap.js";
import * as sessionTargets from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readChannelPairingStateSnapshot } from "../pairing/pairing-store-sqlite.test-helpers.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withStateMigrationBackupForTest } from "../state/openclaw-state-schema.test-support.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createCallerModeSnapshot,
  createCallerModeExecutionFixture,
  expectBlockedTailInPlanOrder,
  snapshotFiles,
  writeLegacyStateSchemaV1,
} from "./state-migrations.caller-mode.test-helpers.js";
import * as deviceIdentityMigrations from "./state-migrations.device-identity.js";
import {
  autoMigrateLegacyState,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import { captureLegacyStateSnapshotIdentityInProcess } from "./state-migrations.snapshot.worker.js";
import type {
  LegacyStateMigrationPlan,
  LegacyStateMigrationStepReceipt,
} from "./state-migrations.types.js";

const tempDirs = createTrackedTempDirs();

function writeJson(filename: string, value: unknown) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value)}\n`);
}

function throwingConfig(property: string, error: Error, config: OpenClawConfig = {}) {
  return Object.defineProperty(config, property, {
    get() {
      throw error;
    },
  });
}

function candidateAt(
  root: string,
): Pick<LegacyStateMigrationPlan["candidate"], "root" | "version"> {
  return { root, version: "test" };
}

function writeLegacyDoctorSources(
  stateDir: string,
  tuiValue: unknown,
): {
  execPath: string;
  tuiPath: string;
} {
  const execPath = path.join(stateDir, "exec-approvals.json");
  const tuiPath = path.join(stateDir, "tui", "last-session.json");
  fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
  writeJson(execPath, {
    version: 1,
    defaults: { security: "allowlist", ask: "on-miss" },
    agents: { main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
  });
  writeJson(tuiPath, tuiValue);
  return { execPath, tuiPath };
}

async function makeFixture(config: OpenClawConfig = {}) {
  const root = await tempDirs.make("openclaw-doctor-caller-refusal-");
  const fixture = createCallerModeExecutionFixture(root);
  writeJson(fixture.configPath, config);
  return fixture;
}

const makeCallerModeFixture = () =>
  makeFixture({ plugins: { entries: { "candidate-plugin": { enabled: true } } } });

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

function planFixture(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof planLegacyStateMigrationsReadOnly>[0]> = {},
) {
  return planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: candidateAt(fixture.root),
    snapshot: createCallerModeSnapshot(fixture),
    env: fixture.env,
    ...overrides,
  });
}

function migrateFixture(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof autoMigrateLegacyState>[0]> = {},
) {
  return autoMigrateLegacyState({
    cfg: {},
    env: fixture.env,
    homedir: () => fixture.homeDir,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...overrides,
  });
}

function expectStep(
  steps: readonly { id: string }[],
  id: string,
  expected: Record<string, unknown>,
) {
  expect(steps.find((step) => step.id === id)).toMatchObject(expected);
}

function expectClosedPlan(plan: LegacyStateMigrationPlan, code: string) {
  expect(plan).toMatchObject({
    mutationAllowed: false,
    outcome: "refused",
    refusal: { code },
    steps: [],
  });
}

function expectBlockedSteps(plan: LegacyStateMigrationPlan, blockerId: string) {
  const index = plan.steps.findIndex((step) => step.id === blockerId);
  expect(index).toBeGreaterThanOrEqual(0);
  for (const step of plan.steps.slice(index + 1)) {
    expect(step).toMatchObject({
      outcome: "deferred",
      refusal: { code: "blocked-by-prior-refusal" },
    });
  }
}

function writeWalSnapshot(databasePath: string) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE marker (value TEXT NOT NULL);
    INSERT INTO marker(value) VALUES ('pending');
  `);
  const sidecars = ["-wal", "-shm"].map((suffix) => ({
    filename: databasePath + suffix,
    bytes: fs.readFileSync(databasePath + suffix),
  }));
  database.close();
  for (const { filename, bytes } of sidecars) {
    fs.writeFileSync(filename, bytes);
  }
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration read-only refusals", () => {
  it("does not accept a caller-asserted staged-candidate artifact identity", async () => {
    const fixture = await makeFixture();
    const assertedCandidate = {
      ...candidateAt(fixture.root),
      artifact: {
        outcome: "bound" as const,
        owner: "staged-candidate" as const,
        digest: `sha256:${"a".repeat(64)}`,
      },
    };

    const plan = await planFixture(fixture, { candidate: assertedCandidate });

    expect(plan).toMatchObject({
      outcome: "refused",
      refusal: { code: "candidate-artifact-digest-required" },
      candidate: {
        artifact: {
          outcome: "deferred",
          refusal: { code: "candidate-artifact-digest-required" },
        },
      },
    });
  });

  it.each([false, true])("closes read-only detection failure (throws: %s)", async (throws) => {
    const fixture = await makeFixture();
    const before = snapshotFiles(fixture.root);
    const message = "session surface unavailable";
    const legacySessionSurfaces = { surfaces: [], failures: [message] };
    if (throws) {
      Object.defineProperty(legacySessionSurfaces, "failures", {
        get() {
          throw new Error(message);
        },
      });
    }
    const plan = await planFixture(fixture, { legacySessionSurfaces });
    if (throws) {
      expectClosedPlan(plan, "migration-detection-failed");
      expect(plan.warnings.join("\n")).toContain(message);
    } else {
      expect(plan).toMatchObject({
        mutationAllowed: false,
        outcome: "refused",
        warnings: [message],
        refusal: { code: "migration-planning-warning" },
      });
      expectStep(plan.steps, "migration-detection", {
        outcome: "deferred",
        refusal: { code: "migration-detection-warning" },
      });
      expectBlockedSteps(plan, "migration-detection");
    }
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it.each(["OAuth", "tilde auth", "configured auth owner", "registered agent"] as const)(
    "refuses an external %s source without inspecting or changing it",
    async (source) => {
      const fixture = await makeFixture();
      const externalDir = path.join(fixture.homeDir, "relocated-auth");
      fs.mkdirSync(externalDir);
      const auth = source === "tilde auth" || source === "configured auth owner";
      const sourcePath = auth
        ? path.join(externalDir, "openclaw-agent.sqlite")
        : source === "registered agent"
          ? path.join(externalDir, "agent.sqlite")
          : externalDir;
      const env = { ...fixture.env };
      if (source === "OAuth") {
        writeJson(path.join(externalDir, "telegram-allowFrom.json"), ["user"]);
        env.OPENCLAW_OAUTH_DIR = externalDir;
      } else if (source === "tilde auth") {
        env.OPENCLAW_AGENT_DIR = "~/relocated-auth";
        for (const suffix of ["", "-wal", "-shm"]) {
          fs.writeFileSync(`${sourcePath}${suffix}`, `protected external auth${suffix}\n`);
        }
      } else if (source === "configured auth owner") {
        writeJson(fixture.configPath, {
          agents: {
            ownership: "explicit",
            defaults: { authInheritance: { agentId: "ops" } },
            entries: { ops: { agentDir: externalDir } },
          },
        });
      } else {
        writeJson(fixture.configPath, { agents: { entries: { legacy: {} } } });
        fs.writeFileSync(sourcePath, "external\n");
        vi.spyOn(sessionTargets, "resolveConfiguredAgentDatabaseTargets").mockReturnValue([
          { agentId: "legacy", path: sourcePath },
        ]);
      }
      const before = snapshotFiles(fixture.root);
      const inspect = vi.spyOn(sharedAuthBootstrap, "inspectSharedAuthLegacyRowsReadOnly");
      const plan = await planFixture(fixture, { env });
      const blocker =
        source === "registered agent" ? "agent-migration-targets" : "migration-detection";
      const code = auth
        ? "shared-auth-source-outside-snapshot"
        : source === "OAuth"
          ? "oauth-dir-outside-snapshot"
          : "session-target-outside-snapshot";
      expectStep(plan.steps, blocker, {
        source: expect.arrayContaining([
          { kind: source === "OAuth" ? "path" : "sqlite", path: sourcePath },
        ]),
        outcome: "deferred",
        refusal: { code },
      });
      expectBlockedSteps(plan, blocker);
      if (auth) {
        expect(plan.refusal?.code).toBe(code);
        if (source === "configured auth owner") {
          expect(inspect).not.toHaveBeenCalled();
        } else {
          expect(inspect.mock.calls.some(([pathname]) => pathname === sourcePath)).toBe(false);
        }
      }
      expect(snapshotFiles(fixture.root)).toEqual(before);
    },
  );

  it("binds and inspects the selected snapshot-bound shared-auth source", async () => {
    const fixture = await makeFixture();
    const authDir = path.join(fixture.stateDir, "relocated-auth");
    const sourcePath = path.join(authDir, "openclaw-agent.sqlite");
    const before = snapshotFiles(fixture.root);
    const inspect = vi.spyOn(sharedAuthBootstrap, "inspectSharedAuthLegacyRowsReadOnly");
    const plan = await planFixture(fixture, {
      env: { ...fixture.env, OPENCLAW_AGENT_DIR: authDir },
    });
    expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
    expect(plan.steps.find((step) => step.id === "shared-auth-store")?.source).toEqual([
      { kind: "sqlite", path: sourcePath },
    ]);
    expect(inspect.mock.calls.some(([pathname]) => pathname === sourcePath)).toBe(true);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("preserves a snapshot-bound OAuth directory in the read-only plan", async () => {
    const fixture = await makeFixture();
    const oauthDir = path.join(fixture.stateDir, "operator-credentials");
    const pairingPath = path.join(oauthDir, "telegram-pairing.json");
    fs.mkdirSync(oauthDir);
    fs.writeFileSync(pairingPath, '{"version":1,"requests":[]}\n');

    const plan = await planFixture(fixture, {
      env: { ...fixture.env, OPENCLAW_OAUTH_DIR: oauthDir },
    });

    expect(plan.steps.find((step) => step.id === "channel-pairing")?.source).toEqual([
      { kind: "path", path: pairingPath },
    ]);
  });

  it("rejects a WAL symlink before shared-memory classification can inspect its target", async () => {
    const fixture = await makeFixture();
    const databasePath = path.join(fixture.stateDir, "snapshot.sqlite");
    const walPath = `${databasePath}-wal`;
    writeWalSnapshot(databasePath);

    const externalDirectory = path.join(fixture.root, "external-wal-target");
    fs.mkdirSync(externalDirectory);
    fs.unlinkSync(walPath);
    fs.symlinkSync(externalDirectory, walPath);

    const plan = await planFixture(fixture);

    expect(plan.snapshot.stateDigest).toBeUndefined();
    expect(plan.warnings).toEqual([
      expect.stringContaining(`Snapshot tree contains a symbolic link: ${walPath}`),
    ]);
  });

  it("hashes verified SQLite shared memory without reopening its pathname", async () => {
    const fixture = await makeFixture();
    const databasePath = path.join(fixture.stateDir, "stable.sqlite");
    const sharedMemoryPath = `${databasePath}-shm`;
    writeWalSnapshot(databasePath);
    const realOpen = fs.promises.open.bind(fs.promises);
    let sharedMemoryOpenCount = 0;
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === sharedMemoryPath) {
        sharedMemoryOpenCount += 1;
        if (sharedMemoryOpenCount > 1) {
          throw new Error("verified shared memory pathname was reopened");
        }
      }
      return realOpen(...args);
    });

    try {
      const identity = await captureLegacyStateSnapshotIdentityInProcess({
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      });
      expect(identity.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(identity.warnings).toEqual([]);
      expect(sharedMemoryOpenCount).toBe(1);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("leaves Doctor-only discovery out of automatic plans and execution", async () => {
    const fixture = await makeFixture();
    const pairingPath = path.join(fixture.stateDir, "credentials", "telegram-allowFrom.json");
    fs.mkdirSync(path.dirname(pairingPath), { recursive: true });
    const pairingBytes = '["legacy-user"]\n';
    fs.writeFileSync(pairingPath, pairingBytes);
    const cfg: OpenClawConfig = { channels: { telegram: { enabled: true } } };
    writeJson(fixture.configPath, cfg);
    const pairingBefore = readChannelPairingStateSnapshot("telegram", fixture.env);

    const plan = await planFixture(fixture, { mode: "automatic" });
    expect(plan.steps.map((step) => step.id)).not.toContain("skill-workshop");
    expect(plan.steps.map((step) => step.id)).not.toContain("channel-pairing");
    expect(fs.readFileSync(pairingPath, "utf8")).toBe(pairingBytes);

    const params = {
      cfg,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    };
    const automatic = await autoMigrateLegacyState(params);
    expect(automatic.stepReceipts.map((step) => step.id)).not.toContain("skill-workshop");
    expect(automatic.stepReceipts.map((step) => step.id)).not.toContain("channel-pairing");
    expect(readChannelPairingStateSnapshot("telegram", fixture.env)).toEqual(pairingBefore);
    expect(fs.readFileSync(pairingPath, "utf8")).toBe(pairingBytes);

    const result = await autoMigrateLegacyState({ ...params, doctorOnlyStateMigrations: true });
    const pairing = result.stepReceipts.find((receipt) => receipt.id === "channel-pairing");
    expect(pairing).toMatchObject({
      source: [{ kind: "path", path: pairingPath }],
      outcome: "completed",
      changes: ["Migrated 1 telegram/default allowFrom entry → shared SQLite state"],
    });
    expect(pairing?.refusal).toBeUndefined();
    expect(readChannelPairingStateSnapshot("telegram", fixture.env).allowFrom).toEqual({
      default: ["legacy-user"],
    });
    expect(fs.existsSync(pairingPath)).toBe(false);
  });

  it("keeps candidate shadow refusal separate from the selected live owner's action order", async () => {
    const fixture = await makeCallerModeFixture();
    const externalPluginRoot = path.join(fixture.root, "external-candidate-plugin");
    fs.mkdirSync(externalPluginRoot);
    writeJson(path.join(externalPluginRoot, "openclaw.plugin.json"), {
      id: "matrix",
      configSchema: { type: "object", additionalProperties: true },
      doctorContract: {
        stateMigrations: [{ id: "matrix-inbound-dedupe-to-claimable-dedupe" }],
      },
    });
    const mutationPath = path.join(fixture.stateDir, "unplanned-external-migration");
    fs.writeFileSync(path.join(externalPluginRoot, "index.cjs"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(externalPluginRoot, "doctor-contract-api.cjs"),
      `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  id: "external-unplanned-action",
  label: "External unplanned action",
  detectLegacyState: () => ({ preview: ["external action pending"] }),
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(mutationPath)}, "mutated");
    return { changes: ["external action migrated"], warnings: [] };
  },
}] };\n`,
    );
    const cfg: OpenClawConfig = {
      plugins: {
        load: { paths: [externalPluginRoot] },
        entries: { matrix: { enabled: true } },
      },
    };
    writeJson(fixture.configPath, cfg);
    const plan = await planFixture(fixture, { mode: "automatic" });

    const result = await migrateFixture(fixture, { cfg });

    const planned = plan.steps.find((step) => step.id === "plugin-doctor-state");
    const receipt = result.stepReceipts.find((step) => step.id === "plugin-doctor-state");
    const owner = (id: string) => ({ kind: "owner", id: `plugin:${id}` });
    const configuredSource = owner("configured-load-paths:state-migrations");
    const matrixAction = owner("matrix:matrix-inbound-dedupe-to-claimable-dedupe");
    expect(planned?.source).toEqual(
      expect.arrayContaining([configuredSource, owner("matrix:state-migrations")]),
    );
    expect(planned?.target).toContainEqual(owner("configured-load-paths:doctor-state"));
    expect(planned?.source).not.toContainEqual(matrixAction);
    expect(receipt).toMatchObject({
      requiredness: "conditional",
      outcome: "refused",
      refusal: { code: "step-refused" },
      warnings: [expect.stringContaining("immutable action order")],
    });
    expect(receipt?.source).toContainEqual(matrixAction);
    expect(receipt?.target).toContainEqual(owner("matrix:doctor-state"));
    expect(receipt?.source).not.toContainEqual(configuredSource);
    expect(fs.existsSync(mutationPath)).toBe(false);
  });

  it("refuses a copied-state tree before an escaped session target can be inspected", async () => {
    const fixture = await makeFixture();
    const externalDir = path.join(fixture.root, "external-session-store");
    const linkedDir = path.join(fixture.stateDir, "linked-session-store");
    const externalDatabase = path.join(externalDir, "sessions.sqlite");
    fs.mkdirSync(externalDir);
    fs.writeFileSync(externalDatabase, "external-bytes\n");
    fs.symlinkSync(externalDir, linkedDir);
    const configuredPath = path.join(linkedDir, "sessions.sqlite");
    const cfg: OpenClawConfig = { session: { store: configuredPath } };
    writeJson(fixture.configPath, cfg);

    const plan = await planFixture(fixture);

    expectClosedPlan(plan, "snapshot-identity-unavailable");
    expect(plan.snapshot.stateDigest).toBeUndefined();
    expect(plan.warnings).toEqual([
      expect.stringContaining(`Snapshot tree contains a symbolic link: ${linkedDir}`),
    ]);
    expect(fs.readFileSync(externalDatabase, "utf8")).toBe("external-bytes\n");
  });

  it.runIf(process.platform !== "win32")(
    "refuses a symlinked state snapshot before migration detection",
    async () => {
      const fixture = await makeCallerModeFixture();
      const stateProbePath = path.join(fixture.stateDir, "identity-probe.json");
      fs.writeFileSync(stateProbePath, "{}\n");
      const discoverTargets = vi.spyOn(sessionTargets, "resolveConfiguredAgentDatabaseTargets");
      const linkedStateDir = path.join(fixture.root, "linked-state");
      fs.symlinkSync(fixture.stateDir, linkedStateDir, "dir");

      const plan = await planFixture(fixture, {
        snapshot: {
          homeDir: fixture.homeDir,
          configPath: fixture.configPath,
          stateDir: linkedStateDir,
        },
        env: fixture.env,
      });

      expectClosedPlan(plan, "snapshot-identity-unavailable");
      expect(plan.snapshot.stateDir).toBe(linkedStateDir);
      expect(plan.snapshot.stateDigest).toBeUndefined();
      expect(discoverTargets).not.toHaveBeenCalled();

      const authorizedPlan = await planFixture(fixture);
      expect(authorizedPlan.steps.find((step) => step.id === "migration-detection")).toBeDefined();
      expect(discoverTargets).toHaveBeenCalled();
    },
  );

  it("plans registered agent targets that a preceding schema repair makes canonical", async () => {
    const fixture = await makeFixture({
      agents: { entries: { legacy: {} } },
      plugins: { entries: { "candidate-plugin": { enabled: true } } },
    });
    const agentDatabasePath = path.join(
      fixture.stateDir,
      "agents",
      "legacy",
      "agent",
      "openclaw-agent.sqlite",
    );
    const stateDatabase = openOpenClawStateDatabase({ env: fixture.env });
    stateDatabase.db
      .prepare(
        `INSERT INTO agent_databases (
           agent_id, path, schema_version, last_seen_at, size_bytes
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy", agentDatabasePath, 1, 1, null);
    const stateDatabasePath = stateDatabase.path;
    closeOpenClawStateDatabaseForTest();
    const legacy = new DatabaseSync(stateDatabasePath);
    try {
      legacy.exec(`
        PRAGMA user_version = 8;
        UPDATE schema_meta SET schema_version = 8;
      `);
    } finally {
      legacy.close();
    }

    const plan = await planFixture(fixture);

    expect(plan.steps[0]).toMatchObject({ id: "state-schema", requiredness: "required" });
    expect(
      plan.steps.find((step) => step.id === "agent-migration-targets")?.refusal,
    ).toBeUndefined();
    expect(plan.steps.find((step) => step.id === "media-persistence")?.source).toContainEqual({
      kind: "sqlite",
      path: agentDatabasePath,
    });
  });

  it.each([
    ["config-machine-state", "doctor"],
    ["config-machine-state", "automatic"],
    ["state-schema", "automatic"],
    ["agent-migration-targets", "doctor"],
    ["migration-detection", "doctor"],
  ] as const)("closes the receipt tail after %s fails in %s mode", async (blockerId, mode) => {
    const fixture = await makeCallerModeFixture();
    const automatic = mode === "automatic";
    const sourcePath = automatic
      ? path.join(fixture.stateDir, "logs", "config-health.json")
      : writeLegacyDoctorSources(fixture.stateDir, {}).execPath;
    if (automatic) {
      writeJson(sourcePath, {
        entries: {
          [path.join(fixture.stateDir, "openclaw.json")]: {
            lastObservedSuspiciousSignature: "leave-me",
          },
        },
      });
    }
    const sourceBytes = fs.readFileSync(sourcePath, "utf8");
    const targetFailure = blockerId === "agent-migration-targets";
    if (targetFailure) {
      writeLegacyStateSchemaV1(resolveOpenClawStateSqlitePath(fixture.env));
    } else if (blockerId === "state-schema") {
      const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      database.exec("CREATE TABLE audit_events (broken TEXT)");
      database.close();
    }
    const plan = await planFixture(fixture, { mode });
    const failure = new Error(`synthetic ${mode} ${blockerId} failure`);
    const lastTouchedAt = "2026-09-02T00:00:00.000Z";
    if (blockerId === "migration-detection") {
      vi.spyOn(deviceIdentityMigrations, "detectLegacyDeviceIdentity").mockImplementationOnce(
        () => {
          throw failure;
        },
      );
    }
    const emittedReceipts: LegacyStateMigrationStepReceipt[] = [];
    const execute = () =>
      migrateFixture(fixture, {
        cfg: targetFailure ? throwingConfig("session", failure, { meta: { lastTouchedAt } }) : {},
        pluginDoctorConfig:
          blockerId === "config-machine-state" ? throwingConfig("meta", failure) : undefined,
        doctorOnlyStateMigrations: !automatic,
        onStepReceipt: (receipt) => emittedReceipts.push(receipt),
      });
    const execution = targetFailure
      ? withStateMigrationBackupForTest({ env: fixture.env }, execute)
      : execute();
    if (!automatic) {
      const result = await execution;
      expect(emittedReceipts).toEqual(result.stepReceipts);
      expect(result.warnings.join("\n")).toContain(failure.message);
    } else if (blockerId === "config-machine-state") {
      await expect(execution).rejects.toBe(failure);
    } else {
      await expect(execution).rejects.toThrow(
        "OpenClaw startup migrations did not complete cleanly",
      );
    }
    expectBlockedTailInPlanOrder({ plan, receipts: emittedReceipts, blockerId });
    if (blockerId !== "migration-detection") {
      expectStep(emittedReceipts, blockerId, {
        outcome: "refused",
        refusal: {
          code: targetFailure
            ? "agent-target-discovery-failed"
            : automatic && blockerId === "state-schema"
              ? "step-refused"
              : "step-threw",
        },
      });
    }
    if (!automatic && blockerId === "config-machine-state") {
      expectStep(emittedReceipts, blockerId, {
        changes: [],
        warnings: [failure.message],
        refusal: { message: failure.message },
      });
    }
    if (targetFailure) {
      expect(emittedReceipts[0]).toMatchObject({ outcome: "completed" });
      expect(emittedReceipts[0]?.changes.length).toBeGreaterThan(0);
      expect(emittedReceipts.slice(1, 3)).toMatchObject([
        { id: "retired-core-state", outcome: "skipped" },
        { id: "config-machine-state", outcome: "completed" },
      ]);
      expect(readConfigMachineState("config.lastTouchedAt", { env: fixture.env })).toBe(
        lastTouchedAt,
      );
    }
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBytes);
  });
});
