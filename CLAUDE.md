# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this is

`machine` — compact aio (Electron) desktop app showing live PC hardware
(CPU/mem/mobo/GPU/disk temps & utilization, lspci/lsusb, net/vpn/firewall).
Linux-first; Win/OSX supported. Syscalls in Rust → WASM. Product spec (source of
truth): `.katana/machine.md`. More detail: `AGENTS.md`, aio internals:
`dep/aio/claude.md`.

## Stack

- **Deno 2.9+ + aio framework** (vendored at `dep/aio` → symlink to sibling
  `../../aio`). Never `npm`/`node`.
- JSX via `jsxImportSource: "aio"`; state via `cell({ state, methods })`
  (methods-only; effects via `s.$do(...)`, own-cell actions via `self()`).
- aio **1.0.23-beta**, pinned in deno.json `aioVersion` (`am pin`); CI checks
  out the public `riagentic/aio` tag `v1.0.23-beta` into `dep/aio`
  (`.github/workflows/ci.yml`). Version = deno.json `"version": "0.4"`; build
  number = git commit count (tag `v0.4.<count>`).
- Persistence: SQLite (`~/.machine/data`); only `theme` + `view` persist
  (`persist: { include }`). Server-only scratch is hidden via `visible.exclude`.
- Rust crate `machine-sys` in `rust/`, target `wasm32-unknown-unknown`.

## Commands

- `deno task dev` — run app (`deno task dev --client=browser` for browser)
- `deno task wasm` (`scripts/wasm.ts`) — build Rust → `src/syscalls.wasm`
  (committed; without cargo/wasm32 the task keeps it and warns — rebuild and
  commit it after changing `rust/`)
- `deno task test` — all tests; single file: `deno test -A test/ui.test.ts`
- `deno run -A dep/aio/aiol/mod.ts .` — aiol, the aio framework linter (flags
  removed config keys / moved imports after aio upgrades)
- `cd rust && cargo test` — Rust parser unit tests (plain string fixtures)
- `deno task am` — app manager: start/stop/status/logs; `am surface --json` =
  live UI perception, `am trigger "<Comp:Name>" <action>` = drive it
- `deno task compile` (Electron) / `deno task build` (all `build.targets`);
  `deno task doctor` — config sanity; `deno task am fix` — repair config
- Verification gate (pre-merge, in order): `deno fmt --check` → `deno lint` →
  `deno check` → `deno test`

## Architecture

Data flow: schedule (2s poll in `src/app.ts`) → `machine.refresh` cell method
(`src/wasm.ts`) → dynamic-imports `src/io.server.ts` → host does all I/O async
(reads `/sys`,`/proc`, spawns `lspci`/`lsusb`/`df`/`ip`) → raw bytes into WASM
(`rust/src/lib.rs` pure string→JSON parsers) → state → `src/App.tsx` renders.

- **`src/wasm.ts`** — the `machine` cell + types. Imported by BOTH server and
  browser: MUST stay browser-safe (no `Deno.*`, no `@std/*`). Also computes
  deltas host-side (CPU util % from two `/proc/stat` samples, net Mbps from raw
  byte counts — `rx_mbps`/`tx_mbps` carry raw bytes in transit, misnamed on
  purpose).
- **`src/io.server.ts`** — server-only WASM loader + I/O + marshalling. Only
  ever reached via dynamic import inside `refresh` (aio marks `*.server.ts`
  dynamic imports as external). #1 gotcha: a static server-only import reaching
  the browser blanks the screen with "Deno is not defined". Missing WASM ⇒ every
  call resolves `null`, never throws.
- **`rust/src/lib.rs`** — PURE parsers, no `std::fs`/`std::process`. Memory
  protocol: host `alloc(len)` → write bytes → `sys_*(ptr,len,…)` → returns ptr
  to 4-byte-LE-length-prefixed UTF-8 → host reads via `str_len(ptr)` →
  `free_str(ptr)` + `dealloc`.
- Platform detection via `Deno.build.os` in the host layer. Linux: `/sys`,
  `/proc`, CLI tools. Windows: per-core CPU ticks via FFI
  (`NtQuerySystemInformation`), everything else through ONE long-lived
  PowerShell session (`pwsh()`; never spawn `powershell` per query). macOS: CPU
  ticks via FFI (`host_processor_info`), `sysctl`/`system_profiler`/`ioreg`/
  `netstat`. Static facts load once (`inventory()`); memory/uptime/swap/load
  come from `Deno.*` on every OS. Pure mappers (`winNet`, `macDf`, …) are
  exported and fixture-tested in `test/host.test.ts`; its live test runs on all
  3 OSes in CI.
- Tests that call `refresh` must end with `await closeHost()` — on Windows the
  PowerShell session is an open child process the leak sanitizer flags.

## aio rules that bite

- **Fail loud, never silent** — warn/throw at the site; never swallow errors.
- **Dev == prod** — no forked paths; state frozen via Immer (illegal mutation
  throws in both).
- **Tests are the strictest env** — no lenient-test shortcuts.
- Heavy I/O stays off the render loop (kata: app must never freeze the PC/OS).
  `effectTimeoutMs`/`perfBudget` in `src/app.ts` are deliberately raised for the
  async refresh — don't "fix" them down.
- In cell methods, live async state arrays: use `.slice()`, not spread (no
  `Symbol.iterator` on intercepted state).

## Testing UIs

Use aio semantic API, not DOM scraping: `testUI(App, "name", async (ui) => {…})`
from `aio/testing`. Element names are LABEL+ROLE from TSX
(`<div class="button">↻</div>` → `RefreshButton`). Queue actions without await
(`ui.App.RefreshButton.click()`); await only observations (`ui.settle()`,
`ui.waitFor(...)`, `expectCell`). Tests live in `test/`, not next to source.
