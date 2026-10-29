# Official extensions

[Planner](planner/README.md) is the selected official extension source. Pushes to main can automatically publish selected extensions after tests; local packaging never publishes or updates the production catalog. Tests also generate isolated fixture extensions. For installation, automatic updates, trust, offline use, retained data and SDK contract changes, see the [user guide](../packages/coding-agent/docs/official-extensions.md). For factory APIs and UI, see the [extension API](../packages/coding-agent/docs/extensions.md) and [TUI guide](../packages/coding-agent/docs/tui.md).

## Authoring contract

Each `extensions/<id>/package.json` is independently versioned and is **not** an npm workspace. Core version synchronization does not touch it. Metadata is generated into the release/catalog, never maintained in another editable listing.

```json
{
  "name": "@grip-extensions/example",
  "version": "1.0.0",
  "description": "A concise description",
  "type": "module",
  "engines": { "grip": ">=0.1.8 <1" },
  "files": ["assets/template.txt"],
  "grip": {
    "official": { "id": "example", "displayName": "Example" },
    "extensions": ["index.ts"],
    "skills": ["skills/example.md"]
  }
}
```

IDs are lowercase kebab-case, at most 64 characters, matching the directory. Versions are strict semver without build metadata. Releases are stable; prerelease artifacts are not published by the workflow. Compatibility is evaluated per release so older Grip clients can use an older compatible version.

Supply a `LICENSE` file. `files` contains exact portable relative asset paths, not npm-style globs/directories. Additional declared `grip.skills`, `rules`, `prompts`, and `themes` entries must be exact files; they are included automatically. Traversal, links, path aliases/collisions, native modules, and code disguised as assets are rejected. Keep extension configuration and user data outside installation directories.

The packager bundles one JS entry at the original entry's relative path (with `.js` suffix), so entry-relative `new URL("./asset.txt", import.meta.url)` works. All other runtime JS dependencies must bundle. Computed imports/require, custom loaders, unsupported imports, and bundle warnings fail rather than installing target dependencies. Dynamically constructed/aliased loading is unsupported and must also be rejected during human source review; static validation is not a security sandbox. Dependencies needing filesystem assets must have those assets declared with paths matching the bundled entry's runtime lookup. Unsupported asset layouts need an author change, not a target npm install.

Only Node builtins and the exact virtual-module keys in `scripts/official-extensions.ts` remain external, matching Grip's standalone loader (Grip packages, typebox and supported subpaths). Arbitrary Grip subpaths are not provided. Test against Node 24 and the standalone loader path. Review dependency licenses before curating: bundle legal comments are retained and `THIRD-PARTY-NOTICES.txt` includes bundled dependencies' package license declarations and LICENSE/COPYING/NOTICE files; absent notices fail packaging. This preserves notices but is not legal approval. No new packaging dependency is added: existing pinned esbuild (MIT) and TypeScript parser are reused.

## Local validation

After `npm ci --ignore-scripts`, run from the repository root:

```sh
npm run extensions:pack -- --out /tmp/grip-official-artifacts
# Check against a saved trusted publication catalog:
npm run extensions:pack -- --out /tmp/grip-official-artifacts --previous /tmp/catalog.json
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/official-contracts.test.ts test/official-packaging.test.ts test/official-automatic-publication.test.ts test/official-planner-artifact.test.ts test/official-planner-lifecycle.test.ts
cd ../..
node node_modules/vitest/dist/cli.js --run --config extensions/planner/vitest.config.mjs
```

Packaging does not execute entry points, lifecycle scripts, Git cloning, or npm installs. Focused tests execute isolated fixture factories and the packaged Planner factory. Production packaging supports an empty directory and preserves historical published releases. Artifacts are deterministic gzip JSON envelopes with schema version, generated manifest and sorted path/base64 file records. The runtime decoder validates size, digest, bounded decompression, manifest agreement and paths before extraction. Limits: 2 MiB catalog, 32 MiB compressed, 128 MiB expanded JSON, 4096 files.

## Independent publication

Maintainers must approve source, dependency licenses and compatibility **before merging to main**: merging authorizes automatic publication. Executable smoke testing remains a maintainer responsibility. Local packaging never publishes.

Pushes to main run tests, with the latest main checked out for queued runs. Unpublished extensions bootstrap at their manifest version. For published extensions, changes anywhere in their directory (including tests and docs), or changes to the bundled artifact from dependencies or tooling, trigger a patch bump unless the author supplied a higher stable version. CI previews generated versions in a disposable checkout; authors need not manually bump versions. Downgrades and prereleases are rejected.

The workflow commits changed `package.json` versions to main and pushes the branch and extension tags atomically, never forcefully. A concurrent newer main push rejects the atomic push; rerun the workflow on main. The bot needs `contents:write` and branch rules that allow its version commit; no bypass is configured.

The workflow directly invokes the existing publisher to publish each immutable artifact before updating the catalog: tag pushes made with `GITHUB_TOKEN` do not trigger workflows. `workflow_dispatch` on main retries or bootstraps publication; if main has changed since a pending tag, select that immutable extension tag for recovery. Explicit `extension-<id>-v<version>` tag publication remains available and validates the tag against the manifest and checkout commit. Neither path publishes npm packages or runs core release/version scripts. Releases set `make_latest: false` so they do not change the latest core product release.

The artifact `<id>-<version>.json.gz` is uploaded to that tag's release without overwrite and independently read/validated before discovery changes. The schema-1 catalog is published at:

`https://github.com/greppleai/grip/releases/download/official-catalog-v1/catalog.json`

All extension publications share a non-canceling concurrency group. Catalog generation merges all historical entries, including releases for now-absent extensions. Identical retries reuse immutable artifacts without incrementing versions; different bytes fail. No-change runs refresh the existing catalog too, repairing discovery after interrupted replacement. A verified `catalog.backup.json` is uploaded before replacing `catalog.json`; retries recover that backup if replacement was interrupted. A missing discovery asset during replacement is a transient failure and clients must fall back to the last valid cached catalog/install. HTTP/authentication errors are not treated as an empty initial catalog. Do not manually run parallel writers or edit/delete release assets; repository write access is the trust root, and checksums provide integrity relative to it, not independent authenticity.

No actual release/publication is part of local validation. Before release, smoke-test feature-bearing npm-managed and compiled standalone executables from outside this checkout with isolated agent directories and fixture catalog/artifacts. Exercise install, dependency/asset loading, restart updates and uninstall; version/help output alone is insufficient. Build authorization is separate from packaging validation. The fixture packaging test exercises jiti/static virtual modules with native import disabled outside the checkout, not a compiled-binary smoke test. The process-backed `test/official-workflow.test.ts` exercises actual source runtime restarts, also not a compiled-binary smoke test.

### Planner 1.0.0 readiness

The initial independent version is `1.0.0`, with tag `extension-planner-v1.0.0`; local packaging creates neither a tag nor a publication. Before merging changes to main:

1. Confirm the approved repository MIT license and bundled `yaml@2.9.1` ISC notice in the generated artifact, and review all source/dependency notices.
2. Review and approve the declared Grip range `>=0.2.1 <0.3.0` against released APIs and the intended executables. Current tests use this checkout; they do not establish compatibility with every release in that range.
3. Run the local checks above, `npm run check`, inspect the artifact and verify deterministic bytes.
4. With separate build authorization, run feature-bearing npm-managed and compiled standalone smoke tests outside the checkout with isolated agent/workspace directories and fixture catalog/artifacts. Exercise Planner install, skill and tool discovery, plan preparation, offline restart and uninstall/data preservation. Source/virtual-loader tests do not replace these executable checks.
5. After approval, merge the source to main to authorize automatic publication. Verify the live catalog before directing users to install it; no core release or npm publication is needed.
