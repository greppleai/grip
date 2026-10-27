# Changelog

All notable changes to Grip are documented in this file.

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

### Breaking Changes

- Removed the built-in LSP client and tools, language-server configuration, daemon protocol support, and SDK/extension LSP APIs.

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
