import fs, { readdirSync as scan } from "node:fs";
import { readdir } from "node:fs/promises";
fs.readdir("root", { recursive: true }, () => {});
fs.readdirSync("root", { recursive: true });
fs.promises.readdir("root", { recursive: true });
readdir("root", { recursive: true, withFileTypes: true });
scan("root", { withFileTypes: true, recursive: true });
fs["readdirSync"]("root", { recursive: true });
fs.readdirSync("root", { recursive: false });
fs.readdirSync("root", { withFileTypes: true });
fs.mkdirSync("root", { recursive: true });
// oxlint-disable-next-line openclaw-boundaries/no-recursive-readdir -- Explicit fixture demonstrating the exception mechanism.
fs.readdirSync("root", { recursive: true });
