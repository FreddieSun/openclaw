import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

export async function fixture(externalAgents = false) {
  const root = await fs.realpath(dirs.make("update-database-backup-preflight-"));
  const stateDir = path.join(root, "state");
  const shared = path.join(stateDir, "state/openclaw.sqlite");
  const backupRoot = path.join(root, "retained-package");
  const directory = `${backupRoot}.databases`;
  const stagingRoot = path.join(root, "scratch");
  const external = externalAgents
    ? [path.join(root, "external-a/agent.sqlite"), path.join(root, "external-b/agent.sqlite")]
    : [];
  for (const parent of [
    path.dirname(shared),
    directory,
    stagingRoot,
    ...external.map((file) => path.dirname(file)),
  ]) {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  }
  for (const file of [shared, ...external]) {
    using db = new DatabaseSync(file);
    db.exec(
      "PRAGMA user_version=17; CREATE TABLE payload(value TEXT); INSERT INTO payload(rowid,value) VALUES(42,'retained');",
    );
    if (file === shared) {
      db.exec("CREATE TABLE agent_databases(path TEXT)");
      for (const agent of external) {
        db.prepare("INSERT INTO agent_databases VALUES (?)").run(agent);
      }
    } else {
      db.exec(
        "CREATE TABLE schema_meta(meta_key TEXT, role TEXT, agent_id TEXT); INSERT INTO schema_meta VALUES ('primary','agent','main');",
      );
      db.prepare("UPDATE payload SET value = ?").run(path.basename(path.dirname(file)));
    }
  }
  const input = { backupRoot, stateDir, config: {}, env: {}, stagingRoot };
  const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
  return {
    root,
    stateDir,
    shared,
    directory,
    external,
    input,
    inspectionPlan,
    capture: () => createUpdateDatabaseBackupInProcess({ ...input, inspectionPlan }),
  };
}
