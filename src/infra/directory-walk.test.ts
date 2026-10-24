import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { DirectoryWalkLimitError, walkDirectory, walkDirectorySync } from "./directory-walk.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each([
  ["async", walkDirectory],
  ["sync", walkDirectorySync],
] as const)("%s directory walk", (_name, walk) => {
  it("reports ancestor, external-directory, and file symlinks without traversing them", async () => {
    const root = tempDirs.make("directory-walk-");
    const outside = tempDirs.make("directory-walk-outside-");
    fs.mkdirSync(path.join(root, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(outside, "private.txt"), "not in this tree");
    fs.symlinkSync(root, path.join(root, "a/b/up"), "dir");
    fs.symlinkSync(outside, path.join(root, "external"), "dir");
    fs.symlinkSync(path.join(outside, "private.txt"), path.join(root, "file"), "file");
    fs.symlinkSync(path.join(outside, "missing"), path.join(root, "dangling"), "file");
    const entries = await walk(root);
    expect(entries.map(({ relativePath }) => relativePath)).toEqual(
      ["a", "a/b", "a/b/up", "dangling", "external", "file"].map((p) =>
        p.split("/").join(path.sep),
      ),
    );
    expect(
      entries
        .filter(({ dirent }) => dirent.isSymbolicLink())
        .map(({ relativePath }) => relativePath),
    ).toEqual(["a/b/up", "dangling", "external", "file"].map((p) => p.split("/").join(path.sep)));
    expect(entries.some(({ dirent }) => dirent.isFile())).toBe(false);
  });

  it("returns deterministic relative paths and types matching a plain recursive listing", async () => {
    const root = tempDirs.make("directory-walk-");
    fs.mkdirSync(path.join(root, "z/empty"), { recursive: true });
    fs.writeFileSync(path.join(root, "z/child.txt"), "child");
    fs.writeFileSync(path.join(root, "a.txt"), "root");
    const entries = await walk(root);
    expect(entries.map(({ relativePath }) => relativePath)).toEqual(
      ["a.txt", "z", "z/child.txt", "z/empty"].map((p) => p.split("/").join(path.sep)),
    );
    // Deliberately link-free compatibility fixture; never run this on a checkout.
    expect(entries.map(({ relativePath }) => relativePath)).toEqual(
      fs.readdirSync(root, { recursive: true }).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(entries.map(({ dirent }) => dirent.isFile())).toEqual([true, false, true, false]);
  });

  it.each([
    [{ maxEntries: 1 }, "maxEntries", 1],
    [{ maxDepth: 1 }, "maxDepth", 1],
  ] as const)(
    "throws a typed error rather than truncating at %j",
    async (options, limit, maximum) => {
      const root = tempDirs.make("directory-walk-");
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(path.join(root, "nested/file"), "child");
      const result = Promise.resolve().then(() => walk(root, options));
      await expect(result).rejects.toMatchObject({
        name: "DirectoryWalkLimitError",
        code: "ERR_DIRECTORY_WALK_LIMIT",
        limit,
        maximum,
      });
      await expect(result).rejects.toBeInstanceOf(DirectoryWalkLimitError);
      expect(await walk(root, { maxEntries: 2, maxDepth: 2 })).toHaveLength(2);
    },
  );

  it("allows an empty root at zero budgets and rejects invalid budgets", async () => {
    const root = tempDirs.make("directory-walk-");
    expect(await walk(root, { maxDepth: 0, maxEntries: 0 })).toEqual([]);
    for (const options of [{ maxDepth: -1 }, { maxEntries: Infinity }, { maxDepth: 0.5 }]) {
      await expect(Promise.resolve().then(() => walk(root, options))).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });

  it("preserves missing/non-directory errors and rejects a symlink root", async () => {
    const root = tempDirs.make("directory-walk-");
    fs.writeFileSync(path.join(root, "file"), "file");
    fs.symlinkSync(root, path.join(root, "link"), "dir");
    await expect(
      Promise.resolve().then(() => walk(path.join(root, "absent"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(Promise.resolve().then(() => walk(path.join(root, "file")))).rejects.toMatchObject(
      { code: "ENOTDIR" },
    );
    await expect(Promise.resolve().then(() => walk(path.join(root, "link")))).rejects.toThrow(
      "root must not be a symlink",
    );
  });
});
