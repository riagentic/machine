# AGENTS.md

## Status

- **Built.** App is scaffolded and working: `deno task wasm` builds the Rust
  syscalls to `src/syscalls.wasm`, `deno task dev` runs the aio app. Product
  spec (`.katana/machine.md`) is the source of truth for requirements.
- Layout: `src/app.ts` (entry) → `src/wasm.ts` (cell + WASM loader + async I/O)
  → `src/App.tsx` (UI) + `src/style.css`. Rust in `rust/` (crate `machine-sys`).
- Tests: `test/cell.test.ts` (testCell), `test/ui.test.ts` (testUI functional).

## What this is

- **`machine`** — compact aio desktop (Electron) app showing live PC hardware
  details (CPU/mem/mobo/GPU/disk temps & utilization, lspci/lsusb lists,
  net/vpn/firewall info). Linux-first, Win/OSX supported.
- System calls written in **Rust**, compiled to **WASM**, consumed by the aio
  app.
- UI: small windows, small font, dense, animated/interactive/reactive,
  Solana-themed colors.
- Must not freeze or block the underlying PC/OS (keep heavy work off the main
  loop).

## Stack — Deno + aio, NOT Node/npm

- Framework is **aio** (`v1.0.0-alpha28`), vendored via `dep/aio` symlink →
  sibling `../../aio`.
- Runtime: **Deno 2.9+**. All commands are `deno ...`, never `npm`/`node`.
- App entrypoint pattern (from aio examples/sibling apps): `src/app.ts` imports
  cells, calls `await aio.run({ appId, cells, ui: {...} })`.
- JSX via `aio/jsx-runtime` (`jsxImportSource: "aio"`); state via
  `cell({ state, methods })` from `aio`.
- Imports map `aio` → `./dep/aio/mod.ts` (and subpaths `aio/air`,
  `aio/jsx-runtime`, etc.) in `deno.json`.
- Persistence is SQLite-only since alpha28 (`data.db`); no unstable flags.
  Periphery symbols (`deepFreeze`, `parseCli`, …) live in `aio/extras`.

## Commands (aio app conventions — from sibling apps)

- Dev server: `deno task dev` → `deno run -A src/app.ts`
- Single-binary: `deno task compile` →
  `deno run -A dep/aio/src/build.ts --compile`
- Electron build: `deno run -A dep/aio/src/build.ts --compile --electron`
- Android build: `deno run -A dep/aio/src/build.ts --android`
- Tests: `deno test -A <dir>`
- App manager: `deno task am` → `deno run -A dep/aio/src/am.ts`
  (start/stop/status/state/dispatch/tt/logs, `am surface 0 --json` for live UI
  perception, `am trigger` to drive it)
- Doctor (config sanity): `deno run -A dep/aio/src/server/doctor.ts`

## Framework conventions that bite (from aio/claude.md)

- **Fail loud, never silent.** Never swallow errors/warnings — warn or throw at
  the site. aio's `__aioDev`/`isDev()` gates must stay dev-strict or
  observe-only; never dev-more-lenient-than-prod.
- **Dev == prod behavior.** No forked code paths. State is frozen (Immer
  autoFreeze never disabled) — illegal mutation throws in dev AND prod.
- **Tests are the STRICTEST env.** `testUI`/`testCell`/`bootCells` run
  dev-strict. Never add a lenient-test shortcut.
- Server binds `127.0.0.1` by default; `--expose` for `0.0.0.0`.
- Tests live in a `test/` (or `tests/`) dir, not next to source.

## Testing UIs — use aio semantic API, not DOM scraping

- In tests: `testUI(App, "name", async (ui) => {...})` from `aio/testing` — auto
  happy-dom, auto-boots cells, full teardown. Actions queue without await
  (`ui.XButton.click()`); await only observations (`expectCell`, `waitFor`,
  `settle`). Names are `LABEL+ROLE` from TSX (`<div class="button">Submit</div>`
  → `SubmitButton`). Use `await using ui = await testUI(App)`.
- Live app: `am surface 0 --json` (full perception) +
  `am trigger 0 "<path>" <action> [text]` — reply includes fresh post-action
  surface. Loop observe→act→observe, one call per step.

## Rust → WASM syscalls

- System/hardware reads are implemented in Rust, compiled to WASM, called from
  the aio app. Keep the Rust layer pure and thin; do the reactive/density work
  in TSX.
- **WASM is pure — the host owns all I/O.** Target is `wasm32-unknown-unknown`
  (no `std::fs`/`std::process`). The host (`src/wasm.ts`) reads files/runs
  commands async (off the dispatch loop) and marshals bytes into WASM memory via
  `alloc`/`dealloc`. Rust functions are pure string-in → JSON-out parsers.
- Memory protocol: host calls `alloc(len)` → writes bytes → calls `sys_*` →
  reads output via `str_len(ptr)` + the shared memory buffer → frees with
  `free_str(ptr)` and `dealloc(ptr, len)`. Outputs are
  4-byte-LE-length-prefixed.
- Prefer reading from `/sys`, `/proc`, `lspci`, `lsusb`, `ip`, etc. on Linux —
  don't shell out from the UI loop; go through the WASM boundary so the app
  never blocks. Windows uses PowerShell/`wmic`; OSX uses `system_profiler`/
  `sysctl`/`ifconfig` — platform detected via `Deno.build.os`.
- Build: `deno task wasm` (cargo build → copies
  `rust/target/.../machine_sys.wasm` → `src/syscalls.wasm`). Rust unit tests:
  `cd rust && cargo test`.

## Verification order (pre-release / pre-merge)

`deno fmt --check` → `deno lint` → `deno check` → `deno test`. Mirror aio's gate
order so "green locally" == "green in CI".

## References

- aio framework internals & full command list: `dep/aio/claude.md`,
  `dep/aio/README.md`, `dep/aio/docs/`.
- Product requirements: `.katana/machine.md`.
- Universal working rules: `/home/u/.katana/_universal.md`.
