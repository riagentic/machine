# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.4] — 2026-10-20

### Added

- **HW tab**: one card with the whole hardware inventory — system, CPU, RAM
  sticks, board/BIOS, GPUs (+VRAM), drives, network, PCI and USB; copyable.
- Windows/macOS: per-core CPU load (native counters via FFI), RAM sticks and
  slots, uptime, swap, OS name, network speed, VPN detection, real USB ids, GPU
  VRAM and (where attributable) GPU load; Windows pending-reboot, BitLocker,
  real-time antivirus and Secure Boot checks without admin; macOS FileVault and
  application-firewall state.
- CI on Linux, Windows and macOS: unit tests for every OS mapper plus a live
  test that reads the real runner's hardware.

### Changed

- Windows no longer starts PowerShell per query (~8 per refresh, one per CPU
  sample): one long-lived session, static facts read once, slow ones cached.
- macOS CPU sampling no longer runs `top` (1s per sample).
- OS row shows the real name ("Ubuntu 24.04 LTS", "Windows 11 Pro").
- aio 1.0.22-beta; lockfile synced to the pinned Electron 44.9.0. README
  compacted; screenshot removed (it showed real machine data).

### Fixed

- Windows network names showed "?" (wrong JSON shape), and one adapter showed
  "—" (PowerShell flattens one-item lists).
- Windows showed a fake 0.00 load average — now hidden there.
- macOS disk showed the sealed system volume as "/" (a few GB used) instead of
  the data volume; system volumes no longer listed.
- macOS USB list included buses and hubs as devices.

## [0.3.3] — 2026-10-18

### Changed

- **aio 1.0.20-beta** (from alpha28): `appVersion` removed from `aio.run()`
  (deno.json `"version": "0.3"`, build number from git); `am pin path:` local
  pin; deps pinned to aio's tested versions (Electron 44.7.0); tasks on the one
  vocabulary (`build`, `compile`, `check`, `lint`, …); `scripts/wasm.ts`
  replaces `rust/build.ts`; hardening opt-ins (`electron.ignoreDebugEnv`,
  `wire.refuseShortCalls`).
- Only theme + selected tab persist; server-only scratch is no longer broadcast.
- I/O cost per poll cut: static sources cached, lspci/lsusb/security every 30s,
  a sleeping NVIDIA dGPU is not woken, Windows CPU = 1 PowerShell/sample.
- Left tab bar: one card at a time, or All (masonry, as many ≥200px columns as
  fit). A single card fills the window at normal text size — its chart and lists
  stretch, lists flow into columns.
- Light theme meets WCAG AA; cores use lime (spec); CPU chart 100px; MOTHERBOARD
  slot bar; PCI/USB rows get device icons.

### Fixed

- CPU % dipped to ~0 every 2s (double sample) — the 1s sampler owns CPU.
- Commands that hang (stale NFS `df`) froze every panel — now SIGKILLed.
- Firewall needed root to detect (ufw showed off); Windows/macOS named "ufw".
- GPU panel vanished on `[N/A]` nvidia-smi fields; board temps were NVMe's;
  hwmon sensors after a numbering gap were lost.
- sshd: first value wins, `Match`/`Include` handled; AppImages, `rsync -l` no
  longer flagged as threats; VPN ignores down/`tap` links.
- Disk free excludes reserved blocks; mounts with spaces; Windows `C:` root.
- Net rates shown without a link cap (Wi-Fi/VPN); rate uses read timestamps.
- Manual refresh during a poll was dropped; paused header said "now".
- Clipboard failures were silent; duplicate "Copy" labels; info rows showed ✓.
- macOS net/mem/CPU parsing; WASM zero-size alloc UB; errors now warn once.

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
