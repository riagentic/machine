# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-24

### Added

- **SECURITY panel** — live security posture with a 0-100 score ring:
  - **Hardening checks** (✓/✗ with fix hints): ASLR, ptrace scope, kptr/dmesg
    restrict, IP forwarding, unprivileged BPF, SSH root login, SSH password
    auth, Secure Boot, disk encryption, pending updates. Checks with unreadable
    inputs are omitted — never false-alarmed.
  - **Listening ports** (`ss -tulnp`) as pills — 🌐 exposed beyond loopback vs
    🔒 local-only, with process names.
  - **Suspicious processes** — world-writable exec dirs (/tmp, /dev/shm), known
    cryptominers, netcat listeners, reverse-shell patterns; flagged THREAT and
    pushed into the TODO card as CRIT.
  - Windows (netstat/Confirm-SecureBootUEFI) and macOS (lsof/SIP/FileVault)
    best-effort fallbacks.
- **More OS suggestions** in the TODO card: exposed-port summary, per-check
  security fixes, kernel-hardening gap aggregate, pending updates count, no
  default route (offline), sustained 15-min load, no swap under memory pressure.
- **cpufreq governor** chip in the system strip.
- New Rust `sys_sec` parser (pure, fixture-tested) + `sec()` host collector.

### Fixed

- **Disk panel false alarm**: AppImage/snap squashfs mounts (always 100% full by
  design) and pseudo-filesystems (tmpfs/efivarfs/…) no longer appear as
  partitions or raise "out of disk space" — removable media under /run/media
  still shows.
- **AppImage blank window** (fixed in the vendored aio framework): the packaged
  Electron app was handed the Deno compile VFS as its document root, fell back
  to a localhost URL prod never binds, and rendered nothing. Electron now gets a
  real-filesystem `dist/` and the zero-TCP-port mode only engages when that
  exists.

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
