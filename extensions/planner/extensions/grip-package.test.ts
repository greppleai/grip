import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  LocalToolOperations,
  SettingsManager,
  type ExtensionContext,
  type ToolAccessMode,
  type ToolBackendInfo,
  type ToolMkdirOptions,
} from "@greppleai/grip";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const toolNames = ["planner_prepare", "planner_step_prepare", "planner_progress_prepare", "planner_handoff_prepare", "planner_start", "planner_done"];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planner-grip-package-"));
  roots.push(root);
  const cwd = join(root, "host");
  const agentDir = join(root, "agent");
  const backendCwd = join(root, "backend");
  await Promise.all([cwd, agentDir, backendCwd].map((path) => mkdir(path)));
  return { root, cwd, agentDir, backendCwd };
}

// Models a remote filesystem through confined fixture IO, not a daemon or network.
class RemoteFixtureOperations extends LocalToolOperations {
  readonly paths: string[] = [];

  private checkPath(path: string): void {
    this.paths.push(path);
    const child = relative(this.cwd, resolve(path));
    if (child === ".." || child.startsWith(`..${sep}`) || resolve(path) === sep) {
      throw new Error(`Remote fixture cannot access host path: ${path}`);
    }
  }

  override async access(path: string, mode?: ToolAccessMode): Promise<void> {
    this.checkPath(path);
    return super.access(path, mode);
  }
  override async readFile(path: string): Promise<Buffer> {
    this.checkPath(path);
    return super.readFile(path);
  }
  override async writeFile(path: string, content: string | Buffer): Promise<void> {
    this.checkPath(path);
    return super.writeFile(path, content);
  }
  override async mkdir(path: string, options?: ToolMkdirOptions): Promise<void> {
    this.checkPath(path);
    return super.mkdir(path, options);
  }
  override async stat(path: string) {
    this.checkPath(path);
    return super.stat(path);
  }
  override async readdir(path: string): Promise<string[]> {
    this.checkPath(path);
    return super.readdir(path);
  }
  override getBackendInfo(): ToolBackendInfo {
    return {
      type: "remote", cwd: this.cwd, url: "ws://fixture.invalid/workspace", protocol: "ws", configured: true,
      workspace: { id: "planner-fixture", root: this.cwd, pathFlavor: "posix" },
    };
  }
}

test("planner is not loaded without an explicit package setting", async () => {
  const f = await fixture();
  const loader = new DefaultResourceLoader({ ...f, settingsManager: SettingsManager.inMemory() });
  await loader.reload();
  expect(loader.getExtensions().extensions).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]);
});

test("Grip manifest loads one planner owner, all six tools and its host-local skill on reload", async () => {
  const f = await fixture();
  const loader = new DefaultResourceLoader({ ...f, settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }) });
  for (let attempt = 0; attempt < 2; attempt++) {
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    const extension = result.extensions[0];
    expect(extension.resolvedPath).toBe(join(packageRoot, "extensions/index.ts"));
    expect([...extension.tools.keys()]).toEqual(toolNames);
    expect([...extension.commands.keys()]).toEqual(["planner"]);
    expect([...extension.handlers.keys()].sort()).toEqual(["agent_end", "session_shutdown", "session_start"]);
    const { skills, diagnostics } = loader.getSkills();
    expect(diagnostics).toEqual([]);
    expect(skills.map((skill) => skill.name)).toEqual(["planner"]);
    expect(skills[0].filePath).toBe(join(packageRoot, "skills/planner/SKILL.md"));
    expect(await readFile(skills[0].filePath, "utf8")).toContain("planner_handoff_prepare");
  }
});

test("package resource filters can disable both planner runtime and skills", async () => {
  const f = await fixture();
  const settingsManager = SettingsManager.inMemory({ packages: [{ source: packageRoot, extensions: [], skills: [] }] });
  const loader = new DefaultResourceLoader({ ...f, settingsManager });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]);
});

test("project package entry wins over duplicate user identity without double registration", async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, ".grip"));
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
  await writeFile(join(f.cwd, ".grip/settings.json"), JSON.stringify({ packages: [{ source: packageRoot, skills: [] }] }));
  const loader = new DefaultResourceLoader({ ...f });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions).toHaveLength(1);
  expect(loader.getExtensions().extensions[0].sourceInfo.scope).toBe("project");
  expect(loader.getSkills().skills).toEqual([]);
});

for (const backend of ["local", "remote"] as const) {
  test(`loaded package prepares plans on the ${backend} backend while resources stay on host`, async () => {
    const f = await fixture();
    const operations = backend === "remote" ? new RemoteFixtureOperations(f.backendCwd) : new LocalToolOperations(f.backendCwd);
    const settingsManager = SettingsManager.inMemory({ packages: [packageRoot] });
    const loader = new DefaultResourceLoader({ ...f, settingsManager, toolOperations: operations });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getSkills().diagnostics).toEqual([]);
    expect(loader.getSkills().skills.map((skill) => skill.filePath)).toEqual([join(packageRoot, "skills/planner/SKILL.md")]);
    const extension = loader.getExtensions().extensions[0];
    const calls: string[] = [];
    const signal = new AbortController().signal;
    // Preparation requires no model/session/UI. Missing unrelated context methods must not be invoked.
    const ctx = {
      cwd: f.cwd, toolOperations: operations, signal,
      execToolBackend: async (command, options) => {
        calls.push(command);
        expect(options?.cwd).toBe(f.backendCwd);
        expect(options?.signal).toBe(signal);
        return { output: "fixture has no Grepple", exitCode: 127, cancelled: false, truncated: false };
      },
    } satisfies Pick<ExtensionContext, "cwd" | "toolOperations" | "signal" | "execToolBackend">;
    const prepare = extension.tools.get("planner_prepare")!;
    const result = await prepare.definition.execute("prepare", { planName: "isolated" }, undefined, undefined, ctx as unknown as ExtensionContext);
    const path = join(f.backendCwd, ".planner/isolated/INDEX.md");
    expect(await readFile(path, "utf8")).toContain("<!-- Write the plan content here. -->");
    expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining(JSON.stringify(path)) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(path);
    await expect(readFile(join(f.cwd, ".planner/isolated/INDEX.md"))).rejects.toThrow();
    await expect(readFile(join(f.backendCwd, "skills/planner/SKILL.md"))).rejects.toThrow();
    if (operations instanceof RemoteFixtureOperations) {
      expect(operations.paths.length).toBeGreaterThan(0);
      expect(operations.paths.every((path) => path === f.backendCwd || path.startsWith(`${f.backendCwd}${sep}`))).toBe(true);
    }
  });
}