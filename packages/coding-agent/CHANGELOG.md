# Changelog

All notable changes to Grip are documented in this file.

## [0.3.3](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.3.2...@greppleai/grip-v0.3.3) (2026-11-10)


### Features

* add policy-restricted host CLI official extension ([3b371c1](https://github.com/greppleai/grip/commit/3b371c1f28535a73283a748bf0d8b0580c982240))
* host-cli-policy - run allowed commands without approval ([593b5f6](https://github.com/greppleai/grip/commit/593b5f6fa06b372ba92fa182d64039b3fc407a4d))
* **host-cli:** feat/host-cli-policy - support optional flag rules and wildcards ([584c0f2](https://github.com/greppleai/grip/commit/584c0f25fbb1d18e494002a45b8fe005919f5622))
* **host-cli:** feat/host-cli-policy - support structured argv policies ([ebc12e9](https://github.com/greppleai/grip/commit/ebc12e9c49bc5101a969e6b06b648365de0bfc10))


### Bug Fixes

* **host-cli:** feat/host-cli-policy - gate tools on sandbox attachment ([cc657f1](https://github.com/greppleai/grip/commit/cc657f17d47f851925d9083d1940174868fa9e6c))
* **sandbox:** preserve-lima-template-mounts - retain extra mounts ([897bd65](https://github.com/greppleai/grip/commit/897bd6533799f786a84c1e7dafbabb00380f5a68))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.3.2 to ^0.3.3
    * @greppleai/grip-ai bumped from ^0.3.2 to ^0.3.3
    * @greppleai/grip-tui bumped from ^0.3.2 to ^0.3.3

## [0.3.2](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.3.1...@greppleai/grip-v0.3.2) (2026-11-05)


### Features

* **grepple:** refresh the CLI and matching Grip skills ([c737987](https://github.com/greppleai/grip/commit/c7379878f045907e50a03b0eaa9de8748c60dbbf))
* **tui:** add opt-in session performance diagnostics ([1455ad1](https://github.com/greppleai/grip/commit/1455ad1449d5ea2500b47e0cef7f7bb7bc03bc1e))


### Bug Fixes

* **jobs:** distinguish preloaded tool calls in job output ([96649b0](https://github.com/greppleai/grip/commit/96649b06f77a98a316e23c1677c4509ee84356d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.3.1 to ^0.3.2
    * @greppleai/grip-ai bumped from ^0.3.1 to ^0.3.2
    * @greppleai/grip-tui bumped from ^0.3.1 to ^0.3.2

## [0.3.1](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.3.0...@greppleai/grip-v0.3.1) (2026-11-04)


### Features

* **extensions:** integrate Grepple as an official extension ([a9d37a7](https://github.com/greppleai/grip/commit/a9d37a7d3a6d3c60348a28f6c4883f674a5098f0))
* **jobs:** add trusted per-task model routing ([5023cf6](https://github.com/greppleai/grip/commit/5023cf68f41633ece2cf1e49c9ba77db4e0d6c83))
* **jobs:** preload child context with tool calls ([43cc4b7](https://github.com/greppleai/grip/commit/43cc4b71bb9a23cb59707db931e761e31362d323))


### Bug Fixes

* **memory:** release compacted history and cache job views ([607df2c](https://github.com/greppleai/grip/commit/607df2c43b65a73e482cacb7299532876a28abe6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.3.0 to ^0.3.1
    * @greppleai/grip-ai bumped from ^0.3.0 to ^0.3.1
    * @greppleai/grip-tui bumped from ^0.3.0 to ^0.3.1

## [0.3.0](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.2.5...@greppleai/grip-v0.3.0) (2026-11-04)


### ⚠ BREAKING CHANGES

* **coding-agent:** Custom PackageManager implementations must provide Git preparation, approved installation, and discard methods.

### Features

* **coding-agent:** git-extensions - add trusted Git installation ([120df90](https://github.com/greppleai/grip/commit/120df90b82da14eb4f327ce65cc613d617dac3ae))


### Bug Fixes

* **coding-agent:** distinguish assistant response stripes ([e29684a](https://github.com/greppleai/grip/commit/e29684a8c339e95ccec0c84387c2d7ac7d167e8a))
* **coding-agent:** extension-display-names - Clarify startup labels ([b7492ff](https://github.com/greppleai/grip/commit/b7492ffd339f74286d1c1581ad400c3f4d630374))
* **coding-agent:** feat/git-extensions - enforce approval expiry and preserve process failures ([51798e6](https://github.com/greppleai/grip/commit/51798e676d81df9ba22422ddf3215c7286a35d45))
* **release:** fix/official-extension-grip-range - sync Grip ranges ([8dd4146](https://github.com/greppleai/grip/commit/8dd41463b7380e1eb11b57d72d412334041188b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.2.5 to ^0.3.0
    * @greppleai/grip-ai bumped from ^0.2.5 to ^0.3.0
    * @greppleai/grip-tui bumped from ^0.2.5 to ^0.3.0

## [0.2.5](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.2.4...@greppleai/grip-v0.2.5) (2026-10-30)


### Features

* **websearch:** Add tavily provider as free alternative to DDG ([25c2563](https://github.com/greppleai/grip/commit/25c25634aeba21d3a17cd55e1a369837fc888409))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.2.4 to ^0.2.5
    * @greppleai/grip-ai bumped from ^0.2.4 to ^0.2.5
    * @greppleai/grip-tui bumped from ^0.2.4 to ^0.2.5

## [0.2.4](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.2.3...@greppleai/grip-v0.2.4) (2026-10-30)


### Bug Fixes

* **coding-agent:** profiles - reload after extension installs ([ca6c66c](https://github.com/greppleai/grip/commit/ca6c66ceb1059ba2111ae7e39281cb12a9cddb2e))
* **coding-agent:** profiles - retain selection across sessions ([aef11e3](https://github.com/greppleai/grip/commit/aef11e3ff0cee2af555ab5cf889425efe009db4b))
* **coding-agent:** profiles - scope official extension selections ([260d1dd](https://github.com/greppleai/grip/commit/260d1ddc6a380ace071ae83f22fae3343ec66f05))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.2.3 to ^0.2.4
    * @greppleai/grip-ai bumped from ^0.2.3 to ^0.2.4
    * @greppleai/grip-tui bumped from ^0.2.3 to ^0.2.4

## [0.2.3](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.2.2...@greppleai/grip-v0.2.3) (2026-10-29)


### Features

* add Codex image generation tool ([1a7db9e](https://github.com/greppleai/grip/commit/1a7db9ef4cd7a0d0db5eac5bea0bdd9a55c7d7ef))
* add profile image model selection ([0c322e0](https://github.com/greppleai/grip/commit/0c322e0ea884be320e0de099dfad633c93d28980))
* show delegated job usage in footer ([7fef8af](https://github.com/greppleai/grip/commit/7fef8af9bf93908b21a50c7eff85341cf5c74eb7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.2.2 to ^0.2.3
    * @greppleai/grip-ai bumped from ^0.2.2 to ^0.2.3
    * @greppleai/grip-tui bumped from ^0.2.2 to ^0.2.3

## [0.2.2](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.2.1...@greppleai/grip-v0.2.2) (2026-10-29)


### Features

* **coding-agent:** feat/official-planner - add Planner extension ([0b5e39e](https://github.com/greppleai/grip/commit/0b5e39e8ca6c87640f43f30b0abff8ba361056ae))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.2.1 to ^0.2.2
    * @greppleai/grip-ai bumped from ^0.2.1 to ^0.2.2
    * @greppleai/grip-tui bumped from ^0.2.1 to ^0.2.2

## [Unreleased]

### Breaking Changes

- Custom `PackageManager` implementations must provide Git extension preparation, approved installation and discard methods; see the [Git approval lifecycle](docs/git-extensions.md#package-manager-hosts).

### Changed

- Publish official extensions automatically after main-branch tests, with independent versioning and immutable artifacts.
- Refresh the Grepple CLI and its version-matched Grip skills at parent-session startup and through `/grepple-install`, honoring offline mode and sandbox host approval.

### Added

- Added Planner as an official extension source.
- Added third-party Git URL installation in `/extensions`, with explicit extension-file manifests, data-only preparation, default-safe trust review, scoped commit-pinned selection and idle reload.
- Added an opt-in Performance diagnostics setting that automatically saves bounded, content-free TUI timing and memory JSONL under `.grip/performance/<session-id>/` in the active working directory.

### Fixed

- Show readable, collision-safe startup extension names for JavaScript/TypeScript entry points and official packages, including Planner, while preserving detailed paths.
- Distinguish completed assistant responses from user messages with a green success-colored stripe instead of the shared accent color.

- Evict compacted message payloads and retained job transcripts from local session memory while preserving disk-backed history access.
- Cache compact job UI snapshots and reuse completed result views without rereading child messages during redraws.

## [0.2.1](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.2.0...@greppleai/grip-v0.2.1) (2026-10-28)


### Bug Fixes

* **coding-agent:** fix/extensions-selector - hide local extensions ([3a84a0e](https://github.com/greppleai/grip/commit/3a84a0efd6ba21a22979f826da4ba196c107b62f))
* **coding-agent:** fix/extensions-selector - use inline extension menu ([e256d85](https://github.com/greppleai/grip/commit/e256d8585b5cda69ab626eb61a8a58cebcc78da1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.2.0 to ^0.2.1
    * @greppleai/grip-ai bumped from ^0.2.0 to ^0.2.1
    * @greppleai/grip-tui bumped from ^0.2.0 to ^0.2.1

## [0.2.0](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.11...@greppleai/grip-v0.2.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* Package hosts must await installed-path/configured-list\nlookups and implement official catalog/startup methods. Resource hosts\nmust provide extension inventory and resolution diagnostics. Official\nmembership changes require transactional install/remove operations.

### Features

* feat/official-extension-installer - add managed extensions ([5fb0d49](https://github.com/greppleai/grip/commit/5fb0d499c19c1361d523eb009a89a088e39a25fe))
* load and cache model catalogs at runtime ([c45535f](https://github.com/greppleai/grip/commit/c45535ffa962313c85c4927117e60dc9dd13fc9b))


### Bug Fixes

* estimate Codex costs and isolate official update tests ([ff88a1b](https://github.com/greppleai/grip/commit/ff88a1bbdf6ffa82c6ca2d523a232f6cfae8e525))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.11 to ^0.2.0
    * @greppleai/grip-ai bumped from ^0.1.11 to ^0.2.0
    * @greppleai/grip-tui bumped from ^0.1.11 to ^0.2.0

## [0.1.11](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.10...@greppleai/grip-v0.1.11) (2026-10-27)


### Bug Fixes

* **sandbox:** sandbox-reattach - Preserve concurrent clients ([8f4d138](https://github.com/greppleai/grip/commit/8f4d138828998f6c653a307205caafbe80119834))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.10 to ^0.1.11
    * @greppleai/grip-ai bumped from ^0.1.10 to ^0.1.11
    * @greppleai/grip-tui bumped from ^0.1.10 to ^0.1.11

## [0.1.10](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.9...@greppleai/grip-v0.1.10) (2026-10-27)


### Features

* **sandbox:** sandbox-workspace - Add workspace selection ([29a1e6d](https://github.com/greppleai/grip/commit/29a1e6d82df11f9a7430a620c7c43360394f6fa5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.9 to ^0.1.10
    * @greppleai/grip-ai bumped from ^0.1.9 to ^0.1.10
    * @greppleai/grip-tui bumped from ^0.1.9 to ^0.1.10

## [0.1.9](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.8...@greppleai/grip-v0.1.9) (2026-10-27)


### Features

* **coding-agent:** add directory-selected settings profiles and sand… ([d956288](https://github.com/greppleai/grip/commit/d95628830f118794510a1bb3eb39324e7b798bb0))
* **coding-agent:** add directory-selected settings profiles and sandbox preferences ([813c984](https://github.com/greppleai/grip/commit/813c984d6232445225e802956ef4a44681fa4e36))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.8 to ^0.1.9
    * @greppleai/grip-ai bumped from ^0.1.8 to ^0.1.9
    * @greppleai/grip-tui bumped from ^0.1.8 to ^0.1.9

## [0.1.8](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.7...@greppleai/grip-v0.1.8) (2026-10-26)


### Features

* **coding-agent:** streamline subagents and organize system prompts ([7c0e400](https://github.com/greppleai/grip/commit/7c0e400634486970de3f19cc4549e5c13a9ec671))


### Bug Fixes

* **coding-agent:** keep sandbox connected when resuming sessions ([712de6a](https://github.com/greppleai/grip/commit/712de6a00edcba98e8fe7fc9483fa7354a16d1e4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.7 to ^0.1.8
    * @greppleai/grip-ai bumped from ^0.1.7 to ^0.1.8
    * @greppleai/grip-tui bumped from ^0.1.7 to ^0.1.8

## [Unreleased]

### Features

- Added `/websearch login` to choose a web search engine and save per-provider API keys in credential storage.
- Added settings profiles with session-only model and job-model switching, directory-prefix startup rules, `/profile sandbox` VM-name completion and combined `--name`/`--autoconnect` controls, and an active-profile footer indicator.

### Added

- Added built-in `/extensions` browsing and managed install/uninstall for independently published, global-only `official:<id>` extensions, with bundled dependencies/assets, compatible startup updates, offline fallback and `officialExtensions` opt-out settings. The production catalog starts empty pending maintainer selection/publication.

### Breaking Changes

- Removed the built-in LSP client and tools, language-server configuration, daemon protocol support, and SDK/extension LSP APIs.
- Package/resource hosts must await `getInstalledPath()` and `listConfiguredPackages()`, implement official catalog/startup methods and `ResourceLoader.getExtensionInventory()`, and include `ResolvedPaths.diagnostics`. Official mutations require transactional `installAndPersist()` / `removeAndPersist()`; see [official extension integration](docs/official-extensions.md#sdk-and-custom-loader-integration).

### Fixed

- Reuse running Lima sandbox daemons for clients in mounted subdirectories without rotating credentials or disconnecting other agents, and handle WebSocket errors during failed connection teardown.

## [0.1.7](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.6...@greppleai/grip-v0.1.7) (2026-10-23)


### Bug Fixes

* **coding-agent:** resolve check diagnostics ([b3410ed](https://github.com/greppleai/grip/commit/b3410edd7eb3074e43ff34227882d0eada35ec09))
* **coding-agent:** support grip update for standalone binary installs ([098a1b5](https://github.com/greppleai/grip/commit/098a1b5c669db5198faaddc8d59d2176b76b5da2))
* **coding-agent:** support grip update for standalone binary installs ([18bc18e](https://github.com/greppleai/grip/commit/18bc18e4c95a9adfa1e93269680a7e423df0aa14))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.6 to ^0.1.7
    * @greppleai/grip-ai bumped from ^0.1.6 to ^0.1.7
    * @greppleai/grip-tui bumped from ^0.1.6 to ^0.1.7

## [0.1.6](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.5...@greppleai/grip-v0.1.6) (2026-10-23)


### Features

* preserve sandbox with /new and chain option completion ([71d3c7e](https://github.com/greppleai/grip/commit/71d3c7e967dc9e8e163fbe3243f2b5751706d1ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.5 to ^0.1.6
    * @greppleai/grip-ai bumped from ^0.1.5 to ^0.1.6
    * @greppleai/grip-tui bumped from ^0.1.5 to ^0.1.6

## [0.1.5](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.4...@greppleai/grip-v0.1.5) (2026-10-22)


### Features

* add OpenRouter browser sign-in with PKCE ([a7ce0f3](https://github.com/greppleai/grip/commit/a7ce0f33357253f6b08981a81408747bced6f267))
* feat/provider-first-model-picker - add native picker ([8f48702](https://github.com/greppleai/grip/commit/8f487023b263acc2e326c74059dd052949104fac))
* show selectable slash command arguments ([cdef6dd](https://github.com/greppleai/grip/commit/cdef6ddd00313fd871f86e13111e9673edd42848))


### Bug Fixes

* bootstrap existing Lima VMs and separate message borders ([d4efede](https://github.com/greppleai/grip/commit/d4efede291816e9d1e56552a9e6eb41f3dc2c3ee))
* identify Grip in OpenRouter attribution headers ([5b4b7d8](https://github.com/greppleai/grip/commit/5b4b7d8dcab5b23c048097e13b56bf17ebbfa2e3))
* pad completed assistant message borders ([1a080a9](https://github.com/greppleai/grip/commit/1a080a9443f6cb43c111aa5a0fc2fac47122ebec))


### Performance Improvements

* feat/provider-first-model-picker - index command lookups ([21d0f92](https://github.com/greppleai/grip/commit/21d0f927e2f945d3de51a5e8c32a7c0c5267b743))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.4 to ^0.1.5
    * @greppleai/grip-ai bumped from ^0.1.4 to ^0.1.5
    * @greppleai/grip-tui bumped from ^0.1.4 to ^0.1.5

## [0.1.4](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.3...@greppleai/grip-v0.1.4) (2026-10-22)


### Features

* **coding-agent:** complete sandbox names from Lima ([395f9f9](https://github.com/greppleai/grip/commit/395f9f93d9cdcf43adcff0a9eb91d2c40e6b252e))


### Bug Fixes

* **coding-agent:** align tool hints and Stop hook card spacing ([b8b9e43](https://github.com/greppleai/grip/commit/b8b9e43790e581c397df51cd4a924102dafc58cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.3 to ^0.1.4
    * @greppleai/grip-ai bumped from ^0.1.3 to ^0.1.4
    * @greppleai/grip-tui bumped from ^0.1.3 to ^0.1.4

## [0.1.3](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.2...@greppleai/grip-v0.1.3) (2026-10-22)


### Bug Fixes

* **coding-agent:** retain submitted commands in editor history ([d5f7105](https://github.com/greppleai/grip/commit/d5f71056c57c77b3d6460dfa6e6d472db148df29))
* **coding-agent:** stripe compaction and final assistant messages ([d3a307d](https://github.com/greppleai/grip/commit/d3a307dac9ed56a9e07a8e0061b592892d204296))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.2 to ^0.1.3
    * @greppleai/grip-ai bumped from ^0.1.2 to ^0.1.3
    * @greppleai/grip-tui bumped from ^0.1.2 to ^0.1.3

## [0.1.2](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.1...@greppleai/grip-v0.1.2) (2026-10-22)


### Bug Fixes

* **coding-agent:** move bash expansion hint below output ([07497cc](https://github.com/greppleai/grip/commit/07497cc0f44c58f99754bcc5a6c805c74b13e226))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.1 to ^0.1.2
    * @greppleai/grip-ai bumped from ^0.1.1 to ^0.1.2
    * @greppleai/grip-tui bumped from ^0.1.1 to ^0.1.2

## [0.1.1](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.1.0...@greppleai/grip-v0.1.1) (2026-10-21)


### Features

* **coding-agent:** stripe user and stop-hook messages ([c5d39b4](https://github.com/greppleai/grip/commit/c5d39b4775a9803f8b1d6fd58267c5ef594eff3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.1.0 to ^0.1.1
    * @greppleai/grip-ai bumped from ^0.1.0 to ^0.1.1
    * @greppleai/grip-tui bumped from ^0.1.0 to ^0.1.1

## [0.1.0](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.0.1...@greppleai/grip-v0.1.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* **release:** Release workflows no longer publish npm packages; use the platform binary installers instead.
* **coding-agent:** /sandbox no longer supports Docker containers or --runtime.

### Features

* **coding-agent:** use Lima-only shared sandboxes ([9a92301](https://github.com/greppleai/grip/commit/9a92301e78426220ae5f1ac634f85ce7356c9d57))
* **release:** ship checksummed single-file Grip binaries ([9fbaf6b](https://github.com/greppleai/grip/commit/9fbaf6bfdc191cf603a9a7963919f567919b02cb))


### Bug Fixes

* **coding-agent:** correct standalone images and TUI styling ([00599f2](https://github.com/greppleai/grip/commit/00599f24db3f40cb038504238588f792abb2ef53))
* **coding-agent:** restore tool backend status after reload ([4424413](https://github.com/greppleai/grip/commit/4424413639ef243480bf4351e9c3aa7125b8f087))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.0.1 to ^0.1.0
    * @greppleai/grip-ai bumped from ^0.0.1 to ^0.1.0
    * @greppleai/grip-tui bumped from ^0.0.1 to ^0.1.0

## [0.0.1](https://github.com/greppleai/grip/compare/@greppleai/grip-v0.2.15...@greppleai/grip-v0.0.1) (2026-10-19)


### Miscellaneous Chores

* release 0.0.1 ([cca34be](https://github.com/greppleai/grip/commit/cca34bef1dd2703a110fc366026d78e5356822ef))
* release 0.0.1 ([31883b2](https://github.com/greppleai/grip/commit/31883b22bd3cd782d58db5f641da69f5921e68a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @greppleai/grip-agent-core bumped from ^0.2.15 to ^0.0.1
    * @greppleai/grip-ai bumped from ^0.2.15 to ^0.0.1
    * @greppleai/grip-tui bumped from ^0.2.15 to ^0.0.1

## [Unreleased]

### Added

- Added `/sandbox start --name <vm> --update` to replace a verified shared Lima guest binary and restart its daemon after disconnecting attached clients.

### Changed

- Replaced tinted tool execution backgrounds with single-cell state-colored indicators and removed trailing display padding.
- Removed full-width backgrounds and trailing padding from hook, compaction, branch, skill, and default custom-message cards; their colored labels remain.
- Removed the full-width user-message background and trailing padding while preserving message spacing and alt-screen navigation markers.
- Colored bash command text with the accent color and elapsed time by execution state, leaving backend location details muted.
- Made `/model` and the model-selection shortcut provider-first, even with one provider, with filtering, backtracking, and scoped/all navigation; exact references and cross-provider query search remain available without a picker extension.

### Fixed

- Fixed the `tools:` backend indicator disappearing from the footer after `/reload`.
- Fixed image loading in standalone binaries by extracting the image resize worker from the executable.
- Fixed `grip update` failing for standalone binary installs; it now downloads the matching release executable, verifies its SHA-256 checksum, and replaces the binary in place (including on Windows).
