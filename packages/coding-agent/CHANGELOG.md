# Changelog

All notable changes to Grip are documented in this file.

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

### Fixed

- Fixed the `tools:` backend indicator disappearing from the footer after `/reload`.
- Fixed image loading in standalone binaries by extracting the image resize worker from the executable.
