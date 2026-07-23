# machine

A compact, live hardware monitor for your PC — CPU, memory, motherboard, GPU,
disks, PCI/USB devices and network, in one dense, animated, Solana-themed
desktop window. Syscalls are written in Rust, compiled to WebAssembly, and
driven by a [Deno](https://deno.com) + [aio](#tech-stack) desktop app.

> Linux-first, with Windows and macOS supported through platform fallbacks.

---

## Highlights

- **🧠 Live vitals** — per-second CPU line chart + per-core heat grid, radial
  utilization gauges, temperatures, frequency and load average.
- **🩺 Health / TODO panel** — automatically flags what's not optimal across
  **hardware, software and security**: full partitions, hot CPU/GPU/DIMMs, high
  swap or load, an inactive firewall, a down VPN, a pending reboot, and more —
  ranked by severity.
- **📋 Copy to clipboard** — every panel (and the whole machine) exports a clean
  Markdown report, ready to paste into a bug report, forum post, or spec sheet.
- **🎨 Dark & light themes** — one click, the whole palette swaps.
- **⏸ Pause** the live poll, **↻ refresh** on demand.
- **📱 Responsive** — the grid reflows from a phone-width frame to a wide
  desktop window; sizing scales with `clamp()`.
- **🛡️ Degrades gracefully** — missing tools, no `dmidecode`, no root, or a
  missing WASM module never crash the app; panels show a clear degraded state.

## What it shows

| Panel             | Data                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **CPU**           | model, threads, utilization (gauge + 100px/sec line chart), per-core boxes, temperature, current/max frequency, load average |
| **Memory**        | used / total / available, usage meter, DIMM temperature, swap, per-module DIMM listing (size, type, speed)                   |
| **Motherboard**   | board, version, product, BIOS + date, USB ports, occupied/total memory slots, sensor temps                                   |
| **GPU**           | model, utilization gauge, temperature, VRAM usage (NVIDIA via `nvidia-smi`; AMD/Intel via `/sys` + platform tools)           |
| **Disk**          | root used vs total (pie), every partition as a color-graded bar                                                              |
| **Network**       | VPN + firewall state, live rx/tx throughput, default route, interface addresses                                              |
| **LSPCI / LSUSB** | integrated and plugged devices, cleaned and icon-tagged                                                                      |
| **TODO**          | ranked health checks (critical / security / warning / info)                                                                  |

Color coding follows fixed thresholds (e.g. temperature: cyan cold → yellow →
red; partitions: cyan < 50% → green < 75% → yellow < 90% → red).

## Requirements

- **[Deno](https://deno.com) 2.9+** — the app runtime and toolchain (no
  `npm`/`node`).
- **The [aio](#tech-stack) framework** at `dep/aio` — this repo expects it as a
  local checkout linked in (see [Setup](#setup)); it is not vendored into the
  repo.
- **Rust + the `wasm32-unknown-unknown` target** — only needed to build the
  syscall module (`deno task wasm`):
  ```sh
  rustup target add wasm32-unknown-unknown
  ```
- Optional CLI tools improve coverage when present: `lspci`, `lsusb`, `ip`,
  `df`, `dmidecode` (DIMM listing needs root), `nvidia-smi`.

## Setup

```sh
git clone <your-fork-url> machine
cd machine

# 1. Link the aio framework at dep/aio (adjust the path to your checkout)
mkdir -p dep && ln -s ../../aio dep/aio

# 2. Build the Rust → WASM syscall module (required once)
deno task wasm

# 3. Run
deno task dev
```

If `deno task wasm` hasn't been run, the app still launches but shows a visible
**"wasm off"** badge and degraded panels.

## Usage

```sh
deno task dev            # run the desktop app (Electron)
deno task dev:browser    # run with a browser client instead
deno task wasm           # (re)build Rust syscalls → src/syscalls.wasm
deno task test           # run the full test suite
deno task doctor         # config sanity check
deno task compile        # produce a standalone build
```

The app manager (`am`) is handy for headless inspection and driving the UI:

```sh
deno task am start
deno task am surface 0 --json          # live UI perception
deno task am trigger 0 "App:RefreshButton" click
deno task am stop
```

## Architecture

```
schedule (2s poll, 1s CPU sampler)  src/app.ts
        │
        ▼
machine.refresh (cell method)       src/wasm.ts      ← browser-safe: types +
        │                                              state + delta math
        ▼  (dynamic import, server-only)
host I/O + WASM marshalling          src/io.server.ts ← reads /sys, /proc;
        │                                              spawns lspci/lsusb/df/ip
        ▼  raw text
pure parsers (text → JSON)           rust/src/lib.rs  ← no std::fs / std::process
        │
        ▼
cell state → render                  src/App.tsx      ← panels, charts, reports
```

- **`src/wasm.ts`** — the `machine` cell (state + types + `refresh`). Imported
  by both server and browser, so it stays browser-safe (no `Deno.*`). Computes
  CPU % and network throughput from deltas between samples.
- **`src/io.server.ts`** — server-only I/O and the WASM loader. Reached only via
  a dynamic import inside `refresh`, so the browser bundle never touches
  `Deno.*`. A missing WASM module makes every call resolve `null` — never
  throws.
- **`rust/src/lib.rs`** — pure `text → JSON` parsers with a small linear-memory
  ABI (`alloc`/`sys_*`/`str_len`/`free_str`). No filesystem or process access.
- **`src/App.tsx`** — the UI: panels, SVG charts, health detection and the
  clipboard reports. Pure logic (health, device cleaning, reports) is exported
  and unit-tested in `test/report.test.ts`.

More detail lives in [`AGENTS.md`](AGENTS.md); the product spec (source of
truth) is in [`.katana/machine.md`](.katana/machine.md).

## Platform support

| OS                  | Data source                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| **Linux** (primary) | `/sys`, `/proc`, `lspci`, `lsusb`, `ip`, `df`, `dmidecode`, `nvidia-smi` |
| **Windows**         | PowerShell `Get-CimInstance` / `Get-Counter`, `nvidia-smi`               |
| **macOS**           | `system_profiler`, `sysctl`, `vm_stat`, `ifconfig`, `nvidia-smi`         |

## Development

Verification gate (run before every merge, in order):

```sh
deno fmt --check
deno lint
deno check
deno task test          # Deno tests (UI + cell + pure logic)
cd rust && cargo test   # Rust parser unit tests
```

The aio linter flags framework-specific issues:

```sh
deno run -A dep/aio/aiol/mod.ts .
```

Tests live in `test/`:

- `test/machine.test.ts` — the `machine` cell (state contract, no-throw
  refresh).
- `test/ui.test.ts` — functional UI tests via the aio `testUI` harness.
- `test/report.test.ts` — pure logic: health detection, device cleaning,
  reports.
- `rust/src/lib.rs` (`#[cfg(test)]`) — parser fixtures (meminfo, lspci, lsusb,
  DIMMs, VPN detection).

## Tech stack

- **[Deno](https://deno.com) 2.9+** — runtime, bundler, test runner, formatter,
  linter.
- **aio** — reactive desktop-app framework (cells + signals + AIR renderer +
  Electron/browser transports). JSX via `jsxImportSource: "aio"`.
- **Rust → WebAssembly** (`wasm32-unknown-unknown`) — the syscall parsers.

## License

Released under the [MIT License](LICENSE).

---

<sub>Built with [aio](https://deno.com). Not affiliated with Solana — the color
palette is an homage.</sub>
