import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const roots: string[] = [];

interface RootManifest {
  workspaces: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface PackedFile {
  path: string;
}

interface PackedPackage {
  name: string;
  files: PackedFile[];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("planner is outside Grip workspaces and root dependencies", async () => {
  const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as RootManifest;
  for (const pattern of manifest.workspaces) {
    expect(new Bun.Glob(pattern).match("extensions/planner")).toBe(false);
  }
  expect(manifest.dependencies).not.toHaveProperty("@greppleai/planner");
  expect(manifest.devDependencies).not.toHaveProperty("@greppleai/planner");
});

test("Grip npm packing excludes planner while planner packs its own runtime and skill", () => {
  for (const directory of ["packages/coding-agent", "extensions/planner"]) {
    const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: join(repository, directory), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const [packed] = JSON.parse(result.stdout) as PackedPackage[];
    const paths = packed.files.map((file) => file.path);
    if (directory === "packages/coding-agent") {
      expect(packed.name).toBe("@greppleai/grip");
      expect(paths.some((path) => /(^|\/)planner(\/|$)/.test(path))).toBe(false);
    } else {
      expect(packed.name).toBe("@greppleai/planner");
      expect(paths.sort()).toEqual([
        "LICENSE", "NOTICE", "README.md", "extensions/index.ts", "extensions/loop-state.ts",
        "extensions/plan-store.ts", "extensions/prompts.ts", "package.json", "skills/planner/SKILL.md",
      ].sort());
    }
  }
});

test("binary asset preparation does not embed repository extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "planner-distribution-"));
  roots.push(root);
  const files = [
    "packages/coding-agent/package.json", "packages/coding-agent/README.md", "packages/coding-agent/CHANGELOG.md",
    "packages/coding-agent/docs/example.md", "packages/coding-agent/examples/example.ts",
    "packages/coding-agent/src/modes/interactive/theme/default.json",
    "packages/coding-agent/src/core/export-html/template.html",
    "packages/coding-agent/dist/bun/image-resize-worker.js",
    "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
    "node_modules/@mariozechner/clipboard/package.json",
    "node_modules/@mariozechner/clipboard-linux-x64-gnu/package.json",
  ];
  const planner = "PLANNER_MUST_NOT_BE_EMBEDDED";
  for (const path of [...files, "extensions/planner/extensions/index.ts", "extensions/planner/skills/planner/SKILL.md"]) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, path.startsWith("extensions/") ? planner : path);
  }
  const script = join(root, "scripts/prepare-binary-assets.mjs");
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, await readFile(join(repository, "scripts/prepare-binary-assets.mjs")));
  const result = spawnSync("node", [script, "linux-x64"], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const assets = JSON.parse(gunzipSync(await readFile(join(root, "packages/coding-agent/dist/bun/grip-assets.blob"))).toString()) as [string, string][];
  expect(assets).toHaveLength(files.length);
  for (const [path, content] of assets) {
    expect(path).not.toContain("planner");
    expect(Buffer.from(content, "base64").toString()).not.toContain(planner);
  }
});