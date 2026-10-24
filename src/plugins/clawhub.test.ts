import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { createZipCentralDirectoryArchive } from "../test-utils/zip-central-directory-fixture.js";
import { clawHubSecurityResponse, clawHubVersionMetadata } from "./clawhub.test-fixtures.js";
import {
  clawHubArchiveFile,
  clawHubPackageDetail,
  createClawHubArchiveFactory,
  createLoggerSpies,
  DEMO_ARCHIVE_INTEGRITY,
  DEMO_ARCHIVE_SHA256,
  DEMO_CLAWPACK_INTEGRITY,
  DEMO_CLAWPACK_SHA256,
  DEMO_PLUGIN_ARCHIVE_ENTRIES,
  expectInstallFailure,
  expectInstallSuccess,
  expectSuccessfulClawHubInstall,
  mockCallArg,
  setClawHubArchiveEntryMode,
  sha256Hex,
  type ArchiveInstallCall,
  type ClawHubArchiveFile,
} from "./clawhub.test-support.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";

const mocks = vi.hoisted(() => ({
  parseSpec: vi.fn(),
  fetchDetail: vi.fn(),
  fetchArtifact: vi.fn(),
  fetchSecurity: vi.fn(),
  fetchVersion: vi.fn(),
  download: vi.fn(),
  cleanup: vi.fn(),
  latestVersion: vi.fn(),
  hostVersion: vi.fn(),
  installArchive: vi.fn(),
  installExtracted: vi.fn(),
}));

// mock-isolation: Fixture package parsing isolates installer behavior from spec parsing.
vi.mock("../infra/clawhub-spec.js", () => ({
  parseClawHubPluginSpec: mocks.parseSpec,
}));

vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: mocks.fetchDetail,
  fetchClawHubPackageArtifact: mocks.fetchArtifact,
  fetchClawHubPackageSecurity: mocks.fetchSecurity,
  fetchClawHubPackageVersion: mocks.fetchVersion,
  resolveLatestVersionFromPackage: mocks.latestVersion,
}));

vi.mock("../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: mocks.download,
}));

vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveCompatibilityHostVersion: mocks.hostVersion,
}));

// mock-isolation: Fixture installation results avoid writing host plugin state.
vi.mock("./install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: { PLUGIN_ID_MISMATCH: "plugin_id_mismatch" },
  installPluginFromArchive: mocks.installArchive,
}));

vi.mock("../infra/archive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/archive.js")>()),
  DEFAULT_MAX_ENTRIES: 50_000,
  DEFAULT_MAX_EXTRACTED_BYTES: 512 * 1024 * 1024,
  DEFAULT_MAX_ENTRY_BYTES: 256 * 1024 * 1024,
}));

const { ClawHubRequestError } = await import("../infra/clawhub-client.js");
const { CLAWHUB_INSTALL_ERROR_CODE: errors, installPluginFromClawHub } =
  await import("./clawhub.js");

const createClawHubArchive = createClawHubArchiveFactory(afterEach);
afterEach(() => vi.restoreAllMocks());
const installDemo = (options: Partial<Parameters<typeof installPluginFromClawHub>[0]> = {}) =>
  installPluginFromClawHub({ spec: "clawhub:demo", ...options });
function mockDownload(download: Record<string, unknown>) {
  mocks.download.mockResolvedValueOnce({ ...download, cleanup: mocks.cleanup });
}
async function useRealInstaller(archivePath: string) {
  const { installPluginFromArchive } = await import("./install-package.js");
  mocks.installArchive.mockImplementationOnce(installPluginFromArchive);
  return path.join(path.dirname(archivePath), "extensions");
}
const npmArtifact = { kind: "npm-pack", format: "tgz", sha256: DEMO_CLAWPACK_SHA256 };
const npmProvenance = { npmIntegrity: "sha512-clawpack", npmShasum: "1".repeat(40) };
const npmDownload = {
  archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
  integrity: DEMO_CLAWPACK_INTEGRITY,
  sha256Hex: DEMO_CLAWPACK_SHA256,
  artifact: "clawpack",
  clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
  ...npmProvenance,
};
const manifestFile = clawHubArchiveFile("openclaw.plugin.json", '{"id":"demo"}');
const artifactPath = "/api/v1/packages/demo/versions/2026.3.22/artifact";
const archiveEntryError = "ClawHub archive fallback verification rejected the downloaded archive: ";
const inventoryError =
  'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": ';
const requestError = (status: number, body: string, requestPath = artifactPath) =>
  new ClawHubRequestError({ path: requestPath, status, body });

function expectUnused(...calls: ReturnType<typeof vi.fn>[]) {
  for (const call of calls) {
    expect(call).not.toHaveBeenCalled();
  }
}

function expectArchiveFailure(result: unknown, error: unknown) {
  expect(result).toMatchObject({ ok: false, code: errors.ARCHIVE_INTEGRITY_MISMATCH, error });
  expectUnused(mocks.installExtracted);
}

function mockVersion(overrides: Record<string, unknown> = {}) {
  mocks.fetchVersion.mockResolvedValueOnce(clawHubVersionMetadata(overrides));
}

async function mockArchive(
  params: {
    entries?: Record<string, string>;
    files?: readonly ClawHubArchiveFile[];
    version?: Record<string, unknown>;
  } = {},
) {
  const entries = { ...params.entries };
  entries["openclaw.plugin.json"] ??= '{"id":"demo"}';
  const archive = await createClawHubArchive(entries);
  mockVersion({
    files:
      params.files ??
      Object.entries(entries)
        .filter(([filePath]) => filePath !== "_meta.json")
        .map(([filePath, contents]) => clawHubArchiveFile(filePath, contents)),
    ...params.version,
  });
  mockDownload(archive);
  return archive;
}

function mockSecurity(
  trust: Record<string, unknown>,
  releaseVersion = "2026.3.22",
  overview = "The plugin can modify local OpenClaw state.",
) {
  mocks.fetchDetail.mockResolvedValue(
    clawHubPackageDetail({ channel: "community", isOfficial: false }),
  );
  mocks.fetchSecurity.mockResolvedValueOnce(
    clawHubSecurityResponse("demo", releaseVersion, trust, overview),
  );
}

function mockPackage(overrides: Record<string, unknown>): void {
  mocks.fetchDetail.mockResolvedValueOnce(clawHubPackageDetail(overrides));
}

const installCall = () => mockCallArg(mocks.installArchive) as ArchiveInstallCall;

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.parseSpec.mockReturnValue({ name: "demo" });
  mocks.fetchDetail.mockResolvedValue(clawHubPackageDetail());
  mocks.latestVersion.mockReturnValue("2026.3.22");
  mocks.fetchVersion.mockResolvedValue(clawHubVersionMetadata({ sha256hash: DEMO_ARCHIVE_SHA256 }));
  mocks.fetchArtifact.mockImplementation((params) => mocks.fetchVersion(params));
  mocks.fetchSecurity.mockImplementation((params: { name?: string; version?: string }) =>
    Promise.resolve(clawHubSecurityResponse(params.name, params.version)),
  );
  mocks.download.mockResolvedValue({
    archivePath: "/tmp/clawhub-demo/archive.zip",
    integrity: DEMO_ARCHIVE_INTEGRITY,
    cleanup: mocks.cleanup,
  });
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.hostVersion.mockReturnValue("2026.3.22");
  mocks.installExtracted.mockResolvedValue({
    ok: true,
    pluginId: "demo",
    targetDir: "/tmp/openclaw/plugins/demo",
    version: "2026.3.22",
  });
  mocks.installArchive.mockImplementation(
    async (
      params: Parameters<typeof import("./install-package.js").installPluginFromArchive>[0],
    ) => {
      if (!params.verification) {
        return await mocks.installExtracted();
      }
      return await withExtractedArchiveRoot({
        archivePath: params.archivePath,
        tempDirPrefix: "openclaw-clawhub-test-",
        timeoutMs: 10_000,
        verification: params.verification,
        rootMarkers: ["openclaw.plugin.json", "SKILL.md"],
        onExtracted: mocks.installExtracted,
      });
    },
  );
});

it("does not publish a ClawHub plugin after authority closes during artifact review", async () => {
  const archive = await mockArchive({ entries: DEMO_PLUGIN_ARCHIVE_ENTRIES });
  const extensionsDir = await useRealInstaller(archive.archivePath);
  let authorityActive = true;
  const result = await installDemo({
    extensionsDir,
    onBeforePluginArtifactCommit: async () => {
      authorityActive = false;
    },
    beforePersistentApply: () => {
      if (!authorityActive) {
        throw new Error("plugin installation authority closed");
      }
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining("plugin installation authority closed"),
  });
  await expect(fs.stat(path.join(extensionsDir, "demo"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  ["package runtimeId", { runtimeId: "demo-runtime" }],
  ["capabilities.runtimeId", { capabilities: { runtimeId: "demo-runtime" } }],
])("pins archive installation to the advertised %s", async (_label, overrides) => {
  mockPackage(overrides);
  await installDemo();
  expect(installCall().expectedPluginId).toBe("demo-runtime");
});

it.each<[Record<string, unknown>, string | undefined]>([
  [{ runtimeId: "advertised-runtime" }, "expected-runtime"],
  [
    { runtimeId: "package-runtime", capabilities: { runtimeId: "capabilities-runtime" } },
    undefined,
  ],
])("rejects runtime id mismatch before download: %s", async (detail, expectedPluginId) => {
  mockPackage(detail);
  expect(expectInstallFailure(await installDemo({ expectedPluginId }))).toMatchObject({
    code: "plugin_id_mismatch",
  });
  expectUnused(mocks.download, mocks.installArchive);
});

it("passes custom-registry provenance and authority to consent", async () => {
  const baseUrl = "https://plugins.example.test";
  const onBeforePluginArtifactCommit = vi.fn();
  const artifact = {
    pluginId: "demo",
    stagedArtifactDir: "/tmp/openclaw/plugins/demo",
    mode: "install" as const,
  };
  mocks.installArchive.mockImplementationOnce(
    async (params: { onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler }) => {
      await params.onBeforePluginArtifactCommit(artifact);
      return { ok: true, pluginId: "demo", targetDir: "/tmp/openclaw/plugins/demo" };
    },
  );
  const result = await installDemo({ baseUrl, onBeforePluginArtifactCommit });
  expect(result.ok).toBe(true);
  expect(onBeforePluginArtifactCommit).toHaveBeenCalledWith({
    ...artifact,
    sourceRecord: {
      source: "clawhub",
      spec: "clawhub:demo",
      clawhubUrl: baseUrl,
      clawhubPackage: "demo",
      clawhubChannel: "official",
      integrity: DEMO_ARCHIVE_INTEGRITY,
    },
  });
  expect(installCall().installPolicyRequest?.source).toEqual({
    kind: "clawhub",
    authority: "third-party",
    mutable: false,
    network: true,
  });
});

it.each(["catalog", "version metadata"])(
  "rejects a %s archive integrity mismatch before extraction",
  async (source) => {
    const expectedIntegrity = `sha256-${Buffer.from("1".repeat(64), "hex").toString("base64")}`;
    if (source === "version metadata") {
      mockVersion({ sha256hash: "1".repeat(64) });
    }
    const onBeforePluginArtifactCommit = vi.fn();
    const result = await installDemo({
      ...(source === "catalog" ? { expectedIntegrity } : {}),
      onBeforePluginArtifactCommit,
    });
    expectArchiveFailure(
      result,
      `ClawHub archive integrity mismatch for "demo@2026.3.22": expected ${expectedIntegrity}, got ${DEMO_ARCHIVE_INTEGRITY}.`,
    );
    expectUnused(mocks.installArchive, onBeforePluginArtifactCommit);
  },
);

it("sanitizes the ClawHub package summary link before logging", async () => {
  const logger = createLoggerSpies();
  await installDemo({
    baseUrl: "https://clawhub.ai/\u001b]8;;https://evil.example\u0007\ninjected",
    logger,
  });
  const summary = logger.info.mock.calls.map(([message]) => message).join("\n");
  expect(summary).toContain("ClawHub");
  expect(summary).not.toContain("\u001b");
  expect(summary).not.toContain("\u0007");
  expect(summary).not.toContain("https://clawhub.ai/\ninjected");
  expect(summary).toContain("https://clawhub.ai/\\ninjected/plugins/demo");
});

it("blocks malicious ClawHub releases before missing-artifact fallback", async () => {
  mockVersion();
  mockSecurity({
    scanStatus: "malicious",
    moderationState: "quarantined",
    blockedFromDownload: true,
    reasons: ["manual_moderation"],
  });
  const logger = { ...createLoggerSpies(), terminalLinks: true };
  const failure = expectInstallFailure(
    await installDemo({ baseUrl: "https://clawhub.ai", logger }),
  );
  expect(failure).toMatchObject({
    code: errors.CLAWHUB_DOWNLOAD_BLOCKED,
    error: "ClawHub blocked this release; install was not started.",
  });
  expect(failure.warning).toContain("Outcome: Blocked");
  expect(failure.warning).not.toContain("\u001b");
  const warning = logger.warn.mock.calls[0]?.[0] ?? "";
  expect(warning).toContain("Overview:");
  expect(warning).toContain("https://clawhub.ai/plugins/demo/security-audit?version=2026.3.22");
  expect(warning).not.toContain('replying "Install"');
  expectUnused(mocks.download, mocks.installArchive);
});

it.each([
  ["install", "not-run", []],
  ["update", "suspicious", ["payload_strings"]],
] as const)(
  "cancels %s before download when confirmation is declined",
  async (mode, scanStatus, reasons) => {
    mockSecurity({ scanStatus, reasons });
    const confirmInstall = vi.fn(async () => false);
    const logger = createLoggerSpies();

    const result = await installDemo({
      baseUrl: "https://clawhub.ai",
      logger,
      confirmInstall,
      mode,
      confirmOnUpdate: mode === "update",
    });

    const failure = expectInstallFailure(result);
    expect(failure.error).toBe("Install cancelled.");
    expect(confirmInstall).toHaveBeenCalledWith(expect.stringContaining("Outcome: Review"));
    expect(mocks.download).not.toHaveBeenCalled();
  },
);

it("sanitizes ClawHub security identity mismatch labels before returning errors", async () => {
  mockSecurity({}, "2026.3.21\nrewritten\u001b[2K");
  const failure = expectInstallFailure(await installDemo({ baseUrl: "https://clawhub.ai" }));
  expect(failure.code).toBe(errors.CLAWHUB_SECURITY_UNAVAILABLE);
  expect(failure.error).toContain('returned version "2026.3.21\\nrewritten"');
  expect(failure.error).not.toContain("\n");
  expect(failure.error).not.toContain("\u001b");
  expectUnused(mocks.download, mocks.installArchive);
});

it("continues after printing a risky ClawHub release as Review", async () => {
  const logger = { ...createLoggerSpies(), terminalLinks: true };
  const confirmInstall = vi.fn(async () => false);
  mockSecurity(
    { scanStatus: "suspicious", reasons: ["payload_strings"] },
    "2026.3.22",
    "Audit summary\u001b[2K\nReview this line.",
  );
  const result = await installDemo({
    baseUrl: "https://clawhub.ai",
    logger,
    mode: "update",
    confirmInstall,
  });

  expectSuccessfulClawHubInstall(result, { clawhubChannel: "community" });
  expect(confirmInstall).not.toHaveBeenCalled();
  const success = expectInstallSuccess(result);
  expect(success.clawhub).toMatchObject({
    clawhubTrustDisposition: "review-required",
    clawhubTrustScanStatus: "suspicious",
    clawhubTrustCheckedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    clawhubTrustReasons: ["payload_strings"],
  });
  expect(success.warning).toContain("Outcome: Review");
  expect(success.warning).toContain("Audit summary");
  expect(success.warning).toContain("Review this line.");
  expect(success.warning).not.toContain("\u001b");
  expect(logger.warn.mock.calls.map(([message]) => message).join("\n")).toContain(
    "https://clawhub.ai/plugins/demo/security-audit?version=2026.3.22",
  );
});

it.each([
  {
    kind: "npm-pack",
    artifact: { kind: "npm-pack", sha256: DEMO_CLAWPACK_SHA256, ...npmProvenance, size: 4096 },
    download: npmDownload,
    expected: {
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      ...npmProvenance,
      clawpackSha256: DEMO_CLAWPACK_SHA256,
      clawpackSize: 4096,
    },
  },
  {
    kind: "legacy-zip",
    artifact: { kind: "legacy-zip", sha256: DEMO_ARCHIVE_SHA256 },
    download: { archivePath: "/tmp/clawhub-demo/archive.zip", integrity: DEMO_ARCHIVE_INTEGRITY },
    expected: {
      artifactKind: "legacy-zip",
      artifactFormat: "zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
    },
  },
])("accepts the live ClawHub $kind resolver shape", async ({ artifact, download, expected }) => {
  mocks.fetchArtifact.mockResolvedValueOnce({
    package: { name: "demo", displayName: "Demo", family: "code-plugin" },
    version: "2026.3.22",
    artifact,
  });
  mockDownload(download);
  const success = expectInstallSuccess(await installDemo({ baseUrl: "https://clawhub.ai" }));
  expect(success.pluginId).toBe("demo");
  expect(success.clawhub).toMatchObject(expected);
});

it("falls back to version metadata when the ClawHub artifact resolver route is missing", async () => {
  mocks.fetchArtifact.mockRejectedValueOnce(requestError(404, "Not Found"));
  mockVersion({
    artifact: {
      ...npmArtifact,
      ...npmProvenance,
      size: 4096,
      npmTarballName: "demo-2026.3.22.tgz",
    },
  });
  mockDownload(npmDownload);
  const success = expectInstallSuccess(await installDemo({ baseUrl: "https://clawhub.ai" }));
  expect(success.clawhub).toMatchObject({
    npmTarballName: "demo-2026.3.22.tgz",
    artifactKind: "npm-pack",
    npmIntegrity: "sha512-clawpack",
    clawpackSha256: DEMO_CLAWPACK_SHA256,
  });
});

it("rejects ClawPack artifacts when the download digest does not match version metadata", async () => {
  const mismatchedSha256 = "c".repeat(64);
  mockVersion({ artifact: npmArtifact });
  mockDownload({
    archivePath: npmDownload.archivePath,
    integrity: `sha256-${Buffer.from(mismatchedSha256, "hex").toString("base64")}`,
    sha256Hex: mismatchedSha256,
    artifact: "clawpack",
    clawpackHeaderSha256: mismatchedSha256,
  });
  const failure = expectInstallFailure(await installDemo({ baseUrl: "https://clawhub.ai" }));
  expect(failure.code).toBe(errors.ARCHIVE_INTEGRITY_MISMATCH);
  expect(failure.error).toBe(
    `ClawHub ClawPack integrity mismatch for "demo@2026.3.22": expected ${DEMO_CLAWPACK_SHA256}, got ${mismatchedSha256}.`,
  );
  expect(mocks.installArchive).not.toHaveBeenCalled();
});

it.each([
  [404, "Not Found", errors.ARTIFACT_DOWNLOAD_UNAVAILABLE, undefined],
  [403, "Blocked: malicious release", errors.CLAWHUB_DOWNLOAD_BLOCKED, "2026.3.22"],
  [403, "Forbidden.", errors.ARTIFACT_UNAVAILABLE, undefined],
] as const)("maps artifact download %s/%s to %s", async (status, body, code, version) => {
  mockVersion({ artifact: npmArtifact });
  mocks.download.mockRejectedValueOnce(requestError(status, body, `${artifactPath}/download`));
  const result = await installDemo({ baseUrl: "https://clawhub.ai" });
  expect(result).toMatchObject({ ok: false, code, version });
  expect(mocks.installArchive).not.toHaveBeenCalled();
});

it.each([
  ["pinned older", "2026.6.8", "2026.6.8", "absent", undefined],
  ["pinned recovery", "2026.6.8", "2026.6.5", "present", "2026.6.8"],
  ["recovery failure", "2026.6.8", "2026.6.8", "error", "500 Internal Server Error"],
  [
    "latest compatibility",
    "2026.6.10",
    "2026.6.8",
    "absent",
    "Upgrade OpenClaw or choose an explicit compatible plugin version.",
  ],
] as const)("compatibility: %s", async (_name, version, host, recovery, error) => {
  const pinned = version === "2026.6.8";
  const spec = pinned ? `clawhub:demo@${version}` : "clawhub:demo";
  mocks.parseSpec.mockReturnValueOnce({ name: "demo", version: pinned ? version : undefined });
  mocks.latestVersion.mockReturnValue("2026.6.10");
  mockPackage({
    latestVersion: "2026.6.10",
    compatibility: { pluginApiRange: ">=2026.6.10", minGatewayVersion: "2026.6.10" },
    artifact: { ...npmArtifact, size: 4096 },
  });
  mocks.hostVersion.mockReturnValue(host);
  mocks.fetchArtifact.mockResolvedValueOnce({
    version: { version, sha256hash: DEMO_ARCHIVE_SHA256 },
  });
  if (recovery === "error") {
    mocks.fetchVersion.mockRejectedValueOnce(new Error("500 Internal Server Error"));
  } else {
    mockVersion({
      version,
      sha256hash: DEMO_ARCHIVE_SHA256,
      compatibility:
        recovery === "present"
          ? { pluginApiRange: ">=2026.6.8", minGatewayVersion: "2026.6.8" }
          : undefined,
    });
  }
  const result = await installPluginFromClawHub({ spec, baseUrl: "https://clawhub.ai" });
  if (error) {
    expect(expectInstallFailure(result).error).toContain(error);
    expect(mocks.download).not.toHaveBeenCalled();
  } else {
    expectSuccessfulClawHubInstall(result);
    const success = expectInstallSuccess(result);
    expect([
      success.clawhub?.clawpackSha256,
      success.clawhub?.clawpackSpecVersion,
      success.clawhub?.clawpackManifestSha256,
      success.clawhub?.clawpackSize,
    ]).toEqual([undefined, undefined, undefined, undefined]);
  }
});

it("validates _meta.json against canonical package and resolved version metadata", async () => {
  mocks.parseSpec.mockReturnValueOnce({ name: "DemoAlias", version: "latest" });
  mockPackage({ tags: { latest: "2026.3.22" } });
  await mockArchive({
    entries: { "_meta.json": '{"slug":"demo","version":"2026.3.22"}' },
    version: { sha256hash: null },
  });
  const logger = createLoggerSpies();
  const success = expectInstallSuccess(
    await installDemo({ spec: "clawhub:DemoAlias@latest", logger }),
  );
  expect(success).toMatchObject({
    pluginId: "demo",
    version: "2026.3.22",
    packageName: "demo",
    clawhub: { clawhubPackage: "demo" },
  });
  expect(installCall()).toMatchObject({
    trustedSourceLinkedOfficialInstall: true,
    installPolicyRequest: { source: { authority: "official" } },
  });
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("files[] verification"));
});

it.each([
  [{ sha256hash: "not-a-sha256", files: [manifestFile] }, "unrecognized value"],
  [{ sha256hash: 123 }, "non-string value"],
  [{ files: [null] }, "expected an object"],
  [{ files: [{ ...manifestFile, sha256: "not-a-digest" }] }, "invalid files[0].sha256"],
  [{ files: [{ ...manifestFile, path: "../evil.txt" }] }, "contains dot segments"],
  [{ files: [{ ...manifestFile, path: "openclaw.plugin.json " }] }, "whitespace"],
  [{ files: [manifestFile, manifestFile] }, "duplicate files[] path"],
  [{ files: [clawHubArchiveFile("_meta.json", "{}")] }, "must not include generated file"],
] as const)("rejects malformed integrity metadata %j before download", async (metadata, issue) => {
  mockVersion(metadata);
  const result = await installDemo();
  expect(result).toMatchObject({
    ok: false,
    code: errors.MISSING_ARCHIVE_INTEGRITY,
    error: expect.stringContaining(issue),
  });
  expect(mocks.download).not.toHaveBeenCalled();
});

it("keeps extraction failures typed and prevents install work after a corrupt ZIP payload", async () => {
  const archive = await mockArchive();
  const bytes = await fs.readFile(archive.archivePath);
  const payloadOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  bytes[payloadOffset] = bytes[payloadOffset]! ^ 1;
  await fs.writeFile(archive.archivePath, bytes);
  expectArchiveFailure(
    await installDemo(),
    "ClawHub archive fallback verification failed while reading the downloaded archive.",
  );
});

const collisionError = expect.stringContaining(
  `${archiveEntryError}archive entries collide at output path`,
);
it.each<[string, string[], number | undefined, unknown]>([
  ["symlink", ["extra.txt"], 0o120777, `${archiveEntryError}zip entry is a link: extra.txt`],
  ["other", ["extra.txt"], 0o160644, `${inventoryError}unexpected file "extra.txt".`],
  ["case collision", ["README.md", "readme.md"], undefined, collisionError],
  ["Unicode normalization collision", ["caf\u00e9.md", "cafe\u0301.md"], undefined, collisionError],
])("explains portable ZIP %s rejection before install work", async (_kind, names, mode, error) => {
  const archive = await mockArchive({
    entries: Object.fromEntries(names.map((name) => [name, "unsupported"])),
    files: [manifestFile],
  });
  if (mode !== undefined) {
    await setClawHubArchiveEntryMode(archive.archivePath, "extra.txt", mode);
  }
  const { configureFsSafeNative, getFsSafeNativeConfig } = await import("@openclaw/fs-safe/config");
  const previous = getFsSafeNativeConfig();
  configureFsSafeNative({ mode: "off" });
  onTestFinished(() => configureFsSafeNative(previous));
  expectArchiveFailure(await installDemo(), error);
});

it.each<[Record<string, string>, readonly ClawHubArchiveFile[], string]>([
  [{ "_meta.json": "{not-json" }, [manifestFile], "_meta.json is not valid JSON."],
  [
    { "_meta.json": '{"slug":"wrong","version":"2026.3.22"}' },
    [manifestFile],
    "_meta.json slug does not match the package name.",
  ],
  [
    {},
    [manifestFile, clawHubArchiveFile("dist/index.js", 'export const demo = "ok";')],
    'missing "dist/index.js".',
  ],
  [{ "nested\\extra.txt": "unexpected" }, [manifestFile], 'unexpected file "nested/extra.txt".'],
])("rejects fallback inventory %j (%j): %s", async (entries, files, error) => {
  await mockArchive({ entries, files });
  expectArchiveFailure(await installDemo(), `${inventoryError}${error}`);
});

it.each([
  ["per-file", false, "ClawHub archive fallback verification exceeded the per-file size limit."],
  ["entry count", true, "ClawHub archive fallback verification exceeded the archive entry limit."],
  [
    "ZIP size",
    false,
    "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
  ],
] as const)(
  "rejects fallback archives exceeding the %s limit",
  async (limit, beforeParse, error) => {
    const { archivePath } = await mockArchive({
      entries:
        limit === "per-file" ? { "_meta.json": '{"slug":"demo","version":"2026.3.22"}' } : {},
    });
    if (limit === "per-file") {
      const archiveBytes = await fs.readFile(archivePath);
      const centralDirectoryOffset = archiveBytes.readUInt32LE(archiveBytes.length - 6);
      // Keep _meta.json's size declarations consistent to reach admission without allocating 256 MiB.
      const oversizedBytes = 256 * 1024 * 1024 + 1;
      archiveBytes.writeUInt32LE(oversizedBytes, 22);
      archiveBytes.writeUInt32LE(oversizedBytes, centralDirectoryOffset + 24);
      await fs.writeFile(archivePath, archiveBytes);
    } else if (beforeParse) {
      await fs.writeFile(
        archivePath,
        createZipCentralDirectoryArchive({
          actualEntryCount: 50_001,
          declaredEntryCount: 1,
          entryType: "directory",
        }),
      );
    } else {
      await fs.truncate(archivePath, 256 * 1024 * 1024 + 1);
    }
    const loadAsyncSpy = beforeParse ? vi.spyOn(JSZip.prototype, "loadAsync") : undefined;
    expectArchiveFailure(await installDemo(), error);
    if (loadAsyncSpy) {
      expect(loadAsyncSpy).not.toHaveBeenCalled();
    }
  },
);

it("rejects fallback verification when a file hash drifts from files[] metadata", async () => {
  const archive = await mockArchive({
    files: [{ path: "openclaw.plugin.json", size: 13, sha256: "1".repeat(64) }],
  });
  const extensionsDir = await useRealInstaller(archive.archivePath);
  const beforePersistentApply = vi.fn();
  const onBeforePluginArtifactCommit = vi.fn();
  const result = await installDemo({
    extensionsDir,
    beforePersistentApply,
    onBeforePluginArtifactCommit,
  });

  expectArchiveFailure(
    result,
    `ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": expected openclaw.plugin.json to hash to ${"1".repeat(64)}, got ${sha256Hex('{"id":"demo"}')}.`,
  );
  expectUnused(beforePersistentApply, onBeforePluginArtifactCommit);
  await expect(fs.stat(extensionsDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("verifies the canonical installed inventory and ignores inert root records", async () => {
  const entries = { ...DEMO_PLUGIN_ARCHIVE_ENTRIES, "nested\\extra.txt": "verified" };
  const archive = await mockArchive({
    entries: { ...entries, ".": "ignored" },
    files: Object.entries(entries).map(([name, contents]) =>
      clawHubArchiveFile(name.replaceAll("\\", "/"), contents),
    ),
  });
  await setClawHubArchiveEntryMode(archive.archivePath, ".", 0o120777);
  const extensionsDir = await useRealInstaller(archive.archivePath);
  const result = await installDemo({
    extensionsDir,
    expectedIntegrity: archive.integrity,
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(await fs.readFile(path.join(extensionsDir, "demo", "nested/extra.txt"), "utf8")).toBe(
    "verified",
  );
  expect(await fs.readFile(path.join(extensionsDir, "demo", "index.js"), "utf8")).toBe(
    DEMO_PLUGIN_ARCHIVE_ENTRIES["index.js"],
  );
});

function mockCompatibility(minGatewayVersion: string, pluginApiRange?: string) {
  mockVersion({
    sha256hash: DEMO_ARCHIVE_SHA256,
    compatibility: { minGatewayVersion, pluginApiRange },
  });
}
function mockMissingPackage(version?: string) {
  mocks.parseSpec.mockReturnValueOnce({ name: "demo", version });
  (version ? mocks.fetchVersion : mocks.fetchDetail).mockRejectedValueOnce(
    requestError(
      404,
      version ? "Version not found" : "Package not found",
      `/api/v1/packages/demo${version ? `/versions/${version}` : ""}`,
    ),
  );
}
it.each([
  [
    errors.INVALID_GATEWAY_VERSION,
    "invalid minGatewayVersion",
    () => mockCompatibility("not-semver", ">=2026.3.22"),
  ],
  [
    errors.INCOMPATIBLE_PLUGIN_API,
    "Upgrade OpenClaw or choose an explicit compatible plugin version",
    () => {
      mocks.hostVersion.mockReturnValueOnce("invalid");
      mockCompatibility("2026.3.0", "*");
    },
  ],
  [errors.ARTIFACT_UNAVAILABLE, "npm:demo@2026.3.22", () => mockVersion({ sha256hash: null })],
  [
    errors.UNKNOWN_GATEWAY_VERSION,
    "host version could not be determined",
    () => {
      mocks.hostVersion.mockReturnValueOnce("unknown");
      mockCompatibility("2026.3.22");
    },
  ],
  [
    errors.SKILL_PACKAGE,
    "openclaw skills install @openclaw/calendar",
    () => mockPackage({ name: "calendar", family: "skill", ownerHandle: "openclaw" }),
  ],
  [errors.PACKAGE_NOT_FOUND, "Package not found", () => mockMissingPackage()],
  [errors.VERSION_NOT_FOUND, "demo@9.9.9", () => mockMissingPackage("9.9.9")],
] as const)("rejects installation with %s", async (code, hint, configure) => {
  configure();
  expect(await installDemo()).toMatchObject({
    ok: false,
    code,
    error: expect.stringContaining(hint),
  });
  expectUnused(mocks.download, mocks.installArchive, mocks.cleanup);
});

it.each([
  { baseUrl: "https://clawhub.ai", blocked: false },
  { baseUrl: "https://mirror.example.test", blocked: true },
])("binds official archive hook bypass to the registry $baseUrl", async ({ baseUrl, blocked }) => {
  mocks.parseSpec.mockReturnValueOnce({ name: "demo", version: "2026.3.22" });
  const archive = await mockArchive({ entries: DEMO_PLUGIN_ARCHIVE_ENTRIES });
  const extensionsDir = await useRealInstaller(archive.archivePath);
  mockPackage({ verification: { tier: "source-linked", sourceRepo: "openclaw/openclaw" } });
  const { createHookRunner } = await import("./hooks.js");
  const { createMockPluginRegistry } = await import("./hooks.test-helpers.js");
  const hookRunnerGlobal = await import("./hook-runner-global.js");
  const rejectInstall = vi
    .fn()
    .mockReturnValue({ block: true, blockReason: "registry policy rejected fixture" });
  const hookRunner = createHookRunner(
    createMockPluginRegistry([
      { pluginId: "registry-policy", hookName: "before_install", handler: rejectInstall },
    ]),
  );
  vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(hookRunner);
  const artifactReview = vi.fn();
  const result = await installPluginFromClawHub({
    spec: "clawhub:demo@2026.3.22",
    baseUrl,
    config: {},
    extensionsDir,
    env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.3.22" },
    onInstallPolicyWarning: async () => ({ status: "approved" }),
    onBeforePluginArtifactCommit: artifactReview,
  });
  if (blocked) {
    expect(result).toMatchObject({
      ok: false,
      code: "security_scan_blocked",
      error: expect.stringContaining("registry policy rejected fixture"),
    });
    expect(artifactReview).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(extensionsDir, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } else {
    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
    expect(rejectInstall).not.toHaveBeenCalled();
    expect(artifactReview).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(extensionsDir, "demo", "index.js"), "utf8")).toBe(
      DEMO_PLUGIN_ARCHIVE_ENTRIES["index.js"],
    );
  }
});
