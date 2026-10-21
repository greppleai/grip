# Changelog

All notable changes to Grip are documented in this file.

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
