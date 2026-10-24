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
  fs.writeFileSync(filename, `${JSON.stringify(value)}\n`);
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

  it("returns a closed refusal when read-only detection cannot produce a safe plan", async () => {
    const fixture = await makeFixture();
    const before = snapshotFiles(fixture.root);
    const plan = await planFixture(fixture, {
      legacySessionSurfaces: { surfaces: [], failures: ["session surface unavailable"] },
    });

    expect(plan).toMatchObject({
      mutationAllowed: false,
      outcome: "refused",
      warnings: ["session surface unavailable"],
      refusal: { code: "migration-planning-warning" },
    });
    expectStep(plan.steps, "migration-detection", {
      outcome: "deferred",
      refusal: { code: "migration-detection-warning" },
    });
    expectBlockedSteps(plan, "migration-detection");
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("returns a closed refusal when copied-state detection throws", async () => {
    const fixture = await makeFixture();
    const before = snapshotFiles(fixture.root);
    const legacySessionSurfaces = Object.defineProperty(
      { surfaces: [], failures: [] },
      "failures",
      {
        get() {
          throw new Error("synthetic copied-state detection failure");
        },
      },
    ) as typeof EMPTY_LEGACY_SESSION_SURFACES;

    const plan = await planFixture(fixture, {
      legacySessionSurfaces,
    });

    expectClosedPlan(plan, "migration-detection-failed");
    expect(plan.warnings.join("\n")).toContain("synthetic copied-state detection failure");
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("refuses an OAuth migration directory outside the copied state without inspecting it", async () => {
    const fixture = await makeFixture();
    const externalOAuthDir = path.join(fixture.root, "external-credentials");
    fs.mkdirSync(externalOAuthDir);
    fs.writeFileSync(path.join(externalOAuthDir, "telegram-allowFrom.json"), '["user"]\n');
    const before = snapshotFiles(fixture.root);

    const plan = await planFixture(fixture, {
      env: { ...fixture.env, OPENCLAW_OAUTH_DIR: externalOAuthDir },
    });

    expectStep(plan.steps, "migration-detection", {
      source: expect.arrayContaining([{ kind: "path", path: externalOAuthDir }]),
      outcome: "deferred",
      refusal: { code: "oauth-dir-outside-snapshot" },
    });
    expectBlockedSteps(plan, "migration-detection");
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it.each(["tilde", "snapshot-bound"] as const)(
    "binds the selected %s shared-auth source without inspecting external state",
    async (pathStyle) => {
      const fixture = await makeFixture();
      const outside = pathStyle !== "snapshot-bound";
      const authDir = path.join(outside ? fixture.homeDir : fixture.stateDir, "relocated-auth");
      const sourcePath = path.join(authDir, "openclaw-agent.sqlite");
      if (outside) {
        fs.mkdirSync(authDir);
        for (const suffix of ["", "-wal", "-shm"]) {
          fs.writeFileSync(`${sourcePath}${suffix}`, `protected external auth${suffix}\n`);
        }
      }
      const before = snapshotFiles(fixture.root);
      const inspect = vi.spyOn(sharedAuthBootstrap, "inspectSharedAuthLegacyRowsReadOnly");

      const plan = await planFixture(fixture, {
        env: {
          ...fixture.env,
          OPENCLAW_AGENT_DIR: pathStyle === "tilde" ? "~/relocated-auth" : authDir,
        },
      });

      if (outside) {
        expect(plan.refusal?.code).toBe("shared-auth-source-outside-snapshot");
        expectStep(plan.steps, "migration-detection", {
          source: expect.arrayContaining([{ kind: "sqlite", path: sourcePath }]),
          outcome: "deferred",
          refusal: { code: "shared-auth-source-outside-snapshot" },
        });
        expectBlockedSteps(plan, "migration-detection");
      } else {
        expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
        expect(plan.steps.find((step) => step.id === "shared-auth-store")?.source).toEqual([
          { kind: "sqlite", path: sourcePath },
        ]);
      }
      expect(inspect.mock.calls.some(([pathname]) => pathname === sourcePath)).toBe(!outside);
      expect(snapshotFiles(fixture.root)).toEqual(before);
    },
  );

  it("refuses a configured auth owner outside the copied snapshot without reading it", async () => {
    const fixture = await makeFixture();
    const ownerDir = path.join(fixture.homeDir, "ops-agent");
    writeJson(fixture.configPath, {
      agents: {
        ownership: "explicit",
        defaults: { authInheritance: { agentId: "ops" } },
        entries: { ops: { agentDir: ownerDir } },
      },
    });
    const inspect = vi.spyOn(sharedAuthBootstrap, "inspectSharedAuthLegacyRowsReadOnly");
    const plan = await planFixture(fixture);

    expect(plan.refusal?.code).toBe("shared-auth-source-outside-snapshot");
    expect(plan.steps.find((step) => step.id === "migration-detection")?.source).toContainEqual({
      kind: "sqlite",
      path: path.join(ownerDir, "openclaw-agent.sqlite"),
    });
    expect(inspect).not.toHaveBeenCalled();
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
    expect(planned?.source).toContainEqual({
      kind: "owner",
      id: "plugin:configured-load-paths:state-migrations",
    });
    expect(planned?.target).toContainEqual({
      kind: "owner",
      id: "plugin:configured-load-paths:doctor-state",
    });
    expect(planned?.source).toContainEqual({ kind: "owner", id: "plugin:matrix:state-migrations" });
    expect(planned?.source).not.toContainEqual({
      kind: "owner",
      id: "plugin:matrix:matrix-inbound-dedupe-to-claimable-dedupe",
    });
    expect(receipt).toMatchObject({
      requiredness: "conditional",
      outcome: "refused",
      refusal: { code: "step-refused" },
      warnings: [expect.stringContaining("immutable action order")],
    });
    expect(receipt?.source).toContainEqual({
      kind: "owner",
      id: "plugin:matrix:matrix-inbound-dedupe-to-claimable-dedupe",
    });
    expect(receipt?.target).toContainEqual({ kind: "owner", id: "plugin:matrix:doctor-state" });
    expect(receipt?.source).not.toContainEqual({
      kind: "owner",
      id: "plugin:configured-load-paths:state-migrations",
    });
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

  it("closes the plan after registered agent database discovery escapes the snapshot", async () => {
    const fixture = await makeFixture();
    const externalDatabasePath = path.join(fixture.root, "registered", "agent.sqlite");
    fs.mkdirSync(path.dirname(externalDatabasePath), { recursive: true });
    fs.writeFileSync(externalDatabasePath, "external\n");
    const cfg: OpenClawConfig = { agents: { entries: { legacy: {} } } };
    writeJson(fixture.configPath, cfg);
    vi.spyOn(sessionTargets, "resolveConfiguredAgentDatabaseTargets").mockReturnValue([
      { agentId: "legacy", path: externalDatabasePath },
    ]);

    const plan = await planFixture(fixture);

    expectStep(plan.steps, "agent-migration-targets", {
      source: expect.arrayContaining([{ kind: "sqlite", path: externalDatabasePath }]),
      outcome: "deferred",
      refusal: { code: "session-target-outside-snapshot" },
    });
    expectBlockedSteps(plan, "agent-migration-targets");
    expect(fs.readFileSync(externalDatabasePath, "utf8")).toBe("external\n");
  });

  it("returns thrown-step receipts and stops later Doctor mutations", async () => {
    const fixture = await makeCallerModeFixture();
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir, {});
    const plan = await planFixture(fixture);
    const pluginDoctorConfig = Object.defineProperty({}, "meta", {
      get() {
        throw new Error("synthetic config migration failure");
      },
    }) as OpenClawConfig;
    const emittedReceipts: LegacyStateMigrationStepReceipt[] = [];

    const result = await migrateFixture(fixture, {
      pluginDoctorConfig,
      doctorOnlyStateMigrations: true,
      onStepReceipt: (receipt) => emittedReceipts.push(receipt),
    });

    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "config-machine-state",
    });
    expectStep(result.stepReceipts, "config-machine-state", {
      id: "config-machine-state",
      outcome: "refused",
      changes: [],
      warnings: ["synthetic config migration failure"],
      refusal: { code: "step-threw", message: "synthetic config migration failure" },
    });
    expect(emittedReceipts).toEqual(result.stepReceipts);
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it.each([
    { blockerId: "config-machine-state", property: "meta" },
    { blockerId: "state-schema", property: null },
  ] as const)(
    "closes receipts before rethrowing automatic $blockerId failure",
    async ({ blockerId, property }) => {
      const fixture = await makeCallerModeFixture();
      const sourcePath = path.join(fixture.stateDir, "logs", "config-health.json");
      const sourceBytes = `${JSON.stringify({
        entries: {
          [path.join(fixture.stateDir, "openclaw.json")]: {
            lastObservedSuspiciousSignature: "leave-me",
          },
        },
      })}\n`;
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, sourceBytes);
      if (!property) {
        const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec("CREATE TABLE audit_events (broken TEXT)");
        database.close();
      }
      const plan = await planFixture(fixture, { mode: "automatic" });
      const failure = new Error(`synthetic automatic ${blockerId} failure`);
      const config = property
        ? (Object.defineProperty({}, property, {
            get() {
              throw failure;
            },
          }) as OpenClawConfig)
        : {};
      const emittedReceipts: LegacyStateMigrationStepReceipt[] = [];
      const execution = migrateFixture(fixture, {
        pluginDoctorConfig: property === "meta" ? config : undefined,
        onStepReceipt: (receipt) => emittedReceipts.push(receipt),
      });
      if (property) {
        await expect(execution).rejects.toBe(failure);
      } else {
        await expect(execution).rejects.toThrow(
          "OpenClaw startup migrations did not complete cleanly",
        );
      }
      expectBlockedTailInPlanOrder({ plan, receipts: emittedReceipts, blockerId });
      expectStep(emittedReceipts, blockerId, {
        outcome: "refused",
        refusal: { code: property ? "step-threw" : "step-refused" },
      });
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBytes);
    },
  );

  it("returns target-discovery refusal after a completed schema step", async () => {
    const fixture = await makeCallerModeFixture();
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir, {});
    writeLegacyStateSchemaV1(resolveOpenClawStateSqlitePath(fixture.env));
    const plan = await planFixture(fixture);
    const lastTouchedAt = "2026-09-02T00:00:00.000Z";
    const cfg = Object.defineProperty({ meta: { lastTouchedAt } }, "session", {
      get() {
        throw new Error("synthetic agent target discovery failure");
      },
    }) as OpenClawConfig;

    const result = await withStateMigrationBackupForTest({ env: fixture.env }, () =>
      migrateFixture(fixture, { cfg, doctorOnlyStateMigrations: true }),
    );

    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "agent-migration-targets",
    });
    expectStep(result.stepReceipts, "agent-migration-targets", {
      id: "agent-migration-targets",
      outcome: "refused",
      refusal: { code: "agent-target-discovery-failed" },
    });
    expect(result.warnings.join("\n")).toContain("synthetic agent target discovery failure");
    expect(result.stepReceipts[0]).toMatchObject({ outcome: "completed" });
    expect(result.stepReceipts[0]?.changes.length).toBeGreaterThan(0);
    expect(result.stepReceipts[1]).toMatchObject({
      id: "retired-core-state",
      outcome: "skipped",
    });
    expect(result.stepReceipts[2]).toMatchObject({
      id: "config-machine-state",
      outcome: "completed",
    });
    expect(readConfigMachineState("config.lastTouchedAt", { env: fixture.env })).toBe(
      lastTouchedAt,
    );
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it("returns detection refusal after preludes and stops later Doctor mutations", async () => {
    const fixture = await makeCallerModeFixture();
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir, {});
    const plan = await planFixture(fixture);
    vi.spyOn(deviceIdentityMigrations, "detectLegacyDeviceIdentity").mockImplementationOnce(() => {
      throw new Error("synthetic execution detection failure");
    });

    const result = await migrateFixture(fixture, { doctorOnlyStateMigrations: true });

    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "migration-detection",
    });
    expect(result.warnings.join("\n")).toContain("synthetic execution detection failure");
    expect(fs.existsSync(execPath)).toBe(true);
  });
});
