// Synthetic, isolated maintenance workload. Never point this at operator data.
// node extensions/memory-lancedb/optimize.bench.mjs seed <new-directory> [rows]
// node extensions/memory-lancedb/optimize.bench.mjs measure <directory> [version]
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import * as lancedb from "@lancedb/lancedb";

const [command, dbPath, rawValue] = process.argv.slice(2);
if (!["seed", "measure"].includes(command) || !dbPath) {
  throw new Error("Usage: optimize.bench.mjs <seed|measure> <isolated-directory> [rows]");
}
const query = "Synthetic canary: the archive's favorite color is sapphire.";
const response = await fetch("http://127.0.0.1:11434/api/embed", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "nomic-embed-text", input: query, keep_alive: -1 }),
});
if (!response.ok) {
  throw new Error(`Local embedding failed: ${response.status}`);
}
const { embeddings } = await response.json();
const vector = embeddings[0];
if (command === "seed") {
  await mkdir(dbPath); // Refuse an existing directory rather than replacing any data.
}
const began = performance.now();
const connection = await lancedb.connect(dbPath);
let table;
try {
  if (command === "seed") {
    const rows = Number(rawValue ?? "40");
    if (!Number.isSafeInteger(rows) || rows < 2) {
      throw new Error("rows must be an integer >= 2");
    }
    const entry = (index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      text: index === 0 ? query : `Synthetic archive item ${index}`,
      vector: index === 0 ? vector : vector.map((value) => -value + index / 100_000),
      agentId: index % 2 ? "other" : "main",
      category: "fact",
      importance: 0.5,
      createdAt: index,
    });
    table = await connection.createTable("memories", [entry(0)]);
    for (let index = 1; index < rows; index++) {
      await table.add([entry(index)]);
    }
    console.log(
      JSON.stringify({
        phase: "seed",
        elapsedMs: performance.now() - began,
        stats: await table.stats(),
        version: await table.version(),
      }),
    );
  } else {
    table = await connection.openTable("memories");
    if (rawValue !== undefined) {
      await table.checkout(Number(rawValue));
    }
    const opened = performance.now();
    const results = await table.vectorSearch(vector).where("agentId = 'main'").limit(3).toArray();
    const searched = performance.now();
    const rows = (await table.query().toArray())
      .map((row) => ({
        id: row.id,
        text: row.text,
        vector: Array.from(row.vector),
        agentId: row.agentId,
        category: row.category,
        importance: row.importance,
        createdAt: row.createdAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    console.log(
      JSON.stringify({
        phase: "measure",
        platform: process.platform,
        arch: process.arch,
        load: os.loadavg(),
        openMs: opened - began,
        searchMs: searched - opened,
        stats: await table.stats(),
        version: await table.version(),
        versions: (await table.listVersions()).map((version) => version.version),
        rowDigest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
        canaries: results.map((row) => ({ id: row.id, text: row.text, distance: row._distance })),
      }),
    );
  }
} finally {
  table?.close();
  connection.close();
}
