#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.GRIP_BINARY_PATH
  ? resolve(repository, process.env.GRIP_BINARY_PATH)
  : join(repository, "packages/coding-agent/dist/grip");
const fixture = join(repository, "packages/coding-agent/test/fixtures/before-compaction.jsonl");
if (!existsSync(source)) throw new Error("Build packages/coding-agent/dist/grip first");
const root = mkdtempSync(join(tmpdir(), "grip-single-binary-test-"));
try {
  const binary = join(root, process.platform === "win32" ? "grip.exe" : "grip");
  copyFileSync(source, binary);
  const version = spawnSync(binary, ["--version"], { cwd: root, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /\d+\.\d+\.\d+/);
  const help = spawnSync(binary, ["--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(`${help.stdout}${help.stderr}`, /--daemon\b/);
  const exportPath = join(root, "session.html");
  const exported = spawnSync(binary, ["--export", fixture, exportPath], { cwd: root, encoding: "utf8" });
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(statSync(exportPath).size > 1000);
  assert.deepEqual(readdirSync(root).sort(), ["session.html", process.platform === "win32" ? "grip.exe" : "grip"].sort());
  console.log("Single-file binary: version, help and HTML export succeeded without adjacent assets");
} finally {
  rmSync(root, { recursive: true, force: true });
}
