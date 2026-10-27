> Grip can help you create Grip packages. Ask it to bundle your extensions, skills, rules, prompt templates, or themes.

# Grip Packages

Grip packages bundle extensions, skills, rules, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `grip` key, or use conventional directories. Independently published [official extensions](official-extensions.md) use a separate `official:<id>` source and bundled artifacts.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Grip Package](#creating-a-grip-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Grip packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
grip install npm:@foo/bar@1.0.0
grip install git:github.com/user/repo@v1
grip install https://github.com/user/repo  # raw URLs work too
grip install /absolute/path/to/package
grip install ./relative/path/to/package

grip remove npm:@foo/bar
grip list                     # show installed packages from settings
grip update                   # update packages; for a compiled CLI rerun the verified installer
grip update --extensions      # update packages and reconcile pinned git refs only
grip update --self            # npm-managed CLI only; compiled binary cannot replace itself
grip update --self --force    # npm-managed CLI only
grip update npm:@foo/bar      # update one package
grip update --extension npm:@foo/bar
```

These commands manage Grip packages, not the Grip CLI installation. To uninstall Grip itself, see [Quickstart](quickstart.md#uninstall). The `@foo/bar` and repository names above are placeholders, not verified published packages.

By default, `install` and `remove` write to user settings (`~/.grip/agent/settings.json`). For npm/git/local packages, use `-l` to write to project settings (`.grip/settings.json`) instead. Project settings can be shared with your team, and Grip installs missing npm/git packages automatically on startup. Official sources are global-only and must be installed explicitly; a missing official selection is not automatically downloaded.

To try an npm/git package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only; official sources do not support temporary installation:

```bash
grip -e npm:@foo/bar
grip -e git:github.com/user/repo
```

## Package Sources

Grip accepts official, npm, git and local source types in settings and `grip install`.

### Official

Use `official:<id>` for a curated, published stable extension. Browse/install/uninstall with `/extensions`, or use `grip install official:<id>` and `grip remove official:<id>`. Official installations are global-only, do not require target-machine Git/npm, and update independently at startup to newer compatible stable versions. They never execute unpublished `main` or unselected catalog entries. The production catalog is initially empty pending maintainer selection/publication.

See [official extensions](official-extensions.md) for full-access trust, live reload, immutable retained versions, offline/recovery behavior and automatic-update opt-out. The npm/git dependency-install instructions below do not apply to official artifacts.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`grip update`, `grip update --extensions`).
- User installs go under `~/.grip/agent/npm/`.
- Project installs go under `.grip/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `grip update` and `grip update --extensions` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `grip install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.grip/agent/git/<host>/<path>` (global) or `.grip/git/<host>/<path>` (project).
- When reconciliation changes the checkout, Grip resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
grip install git:git@github.com:user/repo

# ssh:// protocol format
grip install ssh://git@github.com/user/repo

# With version ref
grip install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, Grip loads resources using package rules.

## Creating a Grip Package

Add a `grip` manifest to `package.json` or use conventional directories. The `grip-package` keyword in this example is optional descriptive metadata; Grip does not require it for package discovery or provide a verified gallery.

```json
{
  "name": "my-grip-package",
  "keywords": ["grip-package"],
  "grip": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "rules": ["./rules"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Gallery Metadata

The [upstream Pi package gallery](https://pi.dev/packages) indexes packages with the historical `pi-package` keyword. It is not a verified Grip gallery. The following preview metadata illustrates that upstream service; do not treat the `pi` manifest key or these gallery fields as a Grip package schema:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `grip` manifest is present, Grip auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `rules/` recursively finds `RULES.md` folders and loads top-level `.md` files as rules
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third-party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, rules, prompt templates, or themes also belong in `dependencies`. When Grip installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Grip bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@greppleai/grip-ai`, `@greppleai/grip-agent-core`, `@greppleai/grip`, `@greppleai/grip-tui`, `typebox`. These package names describe this checkout, not verified npm publication.

Other Grip packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Grip loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "grip": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `grip config` to enable or disable extensions, skills, rules, prompt templates, and themes from installed packages and local directories. Works for both global (`~/.grip/agent`) and project (`.grip/`) scopes.

## Scope and Deduplication

Npm/git/local packages can appear in both global and project settings. If the same package appears in both, the project entry wins. Official sources are user/global-only; project official selections are rejected rather than shadowing a global installation. Identity is determined by:

- official: validated extension ID (no version/ref suffix)
- npm: package name
- git: repository URL without ref
- local: resolved absolute path
