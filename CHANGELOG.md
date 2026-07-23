# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-07-23

First public release.

### Added

- Live hardware panels: **CPU** (per-second line chart, per-core heat grid,
  radial gauge, temperature, frequency, load), **Memory** (usage meter, DIMM
  temperature, swap, per-module listing), **Motherboard** (board/BIOS/slots/
  sensors), **GPU** (gauge, temperature, VRAM), **Disk** (pie + per-partition
  bars), **Network** (VPN/firewall, throughput, addresses), and **LSPCI/LSUSB**
  device lists.
- **Health / TODO panel** — ranked hardware, software and security checks (full
  partitions, hot CPU/GPU/DIMMs, high swap/load, inactive firewall, down VPN,
  pending reboot, long uptime, missing WASM).
- **Copy-to-clipboard** reports per panel and for the whole machine, as portable
  Markdown.
- **Light and dark themes** with a one-click toggle.
- **Pause** control for the live poll.
- System strip (hostname, kernel, arch, uptime, load, process count) and a live
  vitals row in the header.
- Slim themed scrollbars, responsive auto-fit grid, and SVG/CSS animations.

### Fixed

- `readHwmonBlock` skipped `/sys/class/hwmon/*` entries because they are
  symlinks, so **all temperatures (CPU + motherboard) read empty**. Now accepts
  symlinks — CPU, board and DIMM temperatures report correctly.
- `sys_lspci` split `lspci -nnmm` output on spaces instead of its quoted fields,
  mangling device class/vendor/name. Now parses the quoted segments correctly.

### Tooling

- Full verification gate: `deno fmt` · `deno lint` · `deno check` · Deno test
  suite (cell, UI, pure logic) · Rust parser tests.
