#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("Skipping POSIX installer smoke on Windows");
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "grip-install-test-"));
const installer = resolve(dirname(fileURLToPath(import.meta.url)), "../install.sh");
const asset = `grip-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const binary = process.env.GRIP_TEST_BINARY_PATH
  ? readFileSync(resolve(process.env.GRIP_TEST_BINARY_PATH))
  : Buffer.from("#!/bin/sh\nprintf 'mock-grip\\n'\n");
let corrupt = false;
const server = createServer((req, res) => {
  if (req.url?.endsWith(`/${asset}`)) { res.end(binary); return; }
  if (req.url?.endsWith(`/${asset}.sha256`)) {
    const checksum = corrupt ? "0".repeat(64) : createHash("sha256").update(binary).digest("hex");
    res.end(`${checksum}  ${asset}\n`); return;
  }
  res.writeHead(404).end();
});
const run = (env) => new Promise((done, reject) => {
  const child = spawn("sh", [installer], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.once("error", reject);
  child.once("close", (code) => done({ code, output }));
});
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local server address");
  const home = join(root, "home");
  const env = { HOME: home, SHELL: "/bin/bash", GRIP_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}/releases`, GRIP_VERSION: "v1.2.3" };
  const target = join(home, ".local/bin/grip");
  const first = await run(env);
  assert.equal(first.code, 0, first.output);
  assert.deepEqual(readFileSync(target), binary);
  if (process.env.GRIP_TEST_BINARY_PATH) {
    const installed = spawnSync(target, ["--version"], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /\d+\.\d+\.\d+/);
  }
  assert.match(readFileSync(join(home, ".bashrc"), "utf8"), /Grip binary installer PATH/);
  assert.equal((await run(env)).code, 0);
  assert.equal(readFileSync(join(home, ".bashrc"), "utf8").split("Grip binary installer PATH").length, 2);
  corrupt = true;
  const rejected = await run(env);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.output, /SHA-256 mismatch/);
  assert.deepEqual(readFileSync(target), binary);
  rmSync(target);
  symlinkSync(join(root, "outside"), target);
  const symlink = await run(env);
  assert.notEqual(symlink.code, 0);
  assert.match(symlink.output, /symlink/);
  console.log("POSIX installer: verified download, PATH, repeat install, checksum rejection and symlink refusal");
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
