#!/usr/bin/env node
import { gzipSync } from "node:zlib";
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = join(repository, "packages/coding-agent");
const platforms = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"]);
const platform = process.argv[2] ?? `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
if (!platforms.has(platform) || process.argv.length > 3) throw new Error(`Invalid binary platform: ${platform}`);
const entries = new Map();
function add(source, destination) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Binary asset must not be a symlink: ${source}`);
  if (stat.isDirectory()) {
    for (const name of readdirSync(source).sort()) add(join(source, name), `${destination}/${name}`);
    return;
  }
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error(`Invalid binary asset: ${source}`);
  if (destination.startsWith("/") || destination.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe binary asset destination: ${destination}`);
  }
  if (entries.has(destination)) throw new Error(`Duplicate binary asset: ${destination}`);
  entries.set(destination, readFileSync(source).toString("base64"));
}
for (const name of ["package.json", "README.md", "CHANGELOG.md"]) add(join(agent, name), name);
add(join(agent, "docs"), "docs");
add(join(agent, "examples"), "examples");
add(join(agent, "src/modes/interactive/theme"), "theme");
add(join(agent, "src/core/export-html"), "export-html");
add(join(repository, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), "photon_rs_bg.wasm");
const nativePlatform = platform.replace(/^windows-/, "win32-");
const clipboard = platform === "darwin-arm64" ? "clipboard-darwin-arm64" :
  platform === "darwin-x64" ? "clipboard-darwin-x64" :
  platform === "linux-arm64" ? "clipboard-linux-arm64-gnu" :
  platform === "linux-x64" ? "clipboard-linux-x64-gnu" :
  platform === "windows-arm64" ? "clipboard-win32-arm64-msvc" : "clipboard-win32-x64-msvc";
add(join(repository, "node_modules/@mariozechner/clipboard"), "node_modules/@mariozechner/clipboard");
add(join(repository, `node_modules/@mariozechner/${clipboard}`), `node_modules/@mariozechner/${clipboard}`);
if (platform.startsWith("darwin-")) {
  add(join(repository, `packages/tui/native/darwin/prebuilds/${platform}/darwin-modifiers.node`), `native/darwin/prebuilds/${platform}/darwin-modifiers.node`);
} else if (platform.startsWith("windows-")) {
  add(join(repository, `packages/tui/native/win32/prebuilds/${nativePlatform}/win32-console-mode.node`), `native/win32/prebuilds/${nativePlatform}/win32-console-mode.node`);
}
const output = join(agent, "dist/bun/grip-assets.blob");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, gzipSync(JSON.stringify([...entries]), { level: 9 }));
console.log(`Embedded ${entries.size} ${platform} binary assets in ${relative(repository, output)}`);
