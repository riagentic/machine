# machine

Live hardware monitor for your PC — CPU, memory, motherboard, GPU, disks,
security, network, PCI/USB — in one compact desktop window. Parsers in Rust →
WebAssembly, app on [Deno](https://deno.com) +
[aio](https://jsr.io/@riagentic/aio). Linux-first; Windows/macOS via fallbacks.

![machine — all cards view](docs/screenshot.png)

## Features

- 🧠 **Live vitals** — per-second CPU chart, per-core heat grid, gauges, temps,
  frequency, load.
- 🩺 **TODO** — ranks what's not optimal: full disks, hot parts, swap, firewall,
  open ports, suspicious processes, pending reboot.
- 🛡️ **Security** — 0–100 posture score, hardening checks, listening ports.
- 🗂 **Tabs** — one card filling the window, or **All** in as many columns as
  fit.
- 📋 **Copy** any card (or everything) as Markdown.
- 🎨 Dark/light theme · ⏸ pause · ↻ refresh. Never blocks the OS: slow tools are
  cached, timed out and killed.

## Quick start

Needs [Deno](https://deno.com) 2.9+, an aio checkout, and Rust with
`wasm32-unknown-unknown` (`rustup target add wasm32-unknown-unknown`).

```sh
git clone <repo-url> machine && cd machine
mkdir -p dep && ln -s /abs/path/to/aio dep/aio   # the aio framework
deno task wasm                                  # build the Rust parsers (once)
deno task dev                                   # run (add --client=browser for a tab)
```

Optional tools widen coverage: `lspci`, `lsusb`, `ip`, `ss`, `df`, `dmidecode`
(DIMMs need root), `nvidia-smi`. Without WASM the app runs with a "wasm off"
badge.

| Task                          | Does                                                 |
| ----------------------------- | ---------------------------------------------------- |
| `deno task test`              | Deno tests (`cd rust && cargo test` for the parsers) |
| `deno task lint`              | `deno lint` + aio linter                             |
| `deno task compile`           | desktop (Electron) package → `dist/`                 |
| `deno task build`             | every target in `build.targets`                      |
| `deno task am <cmd>`          | app manager: `start`, `surface`, `trigger`, `logs`   |
| `deno task doctor` / `am fix` | config check / repair                                |

## How it works

```
schedules (2s full, 1s CPU)  src/app.ts
  → machine cell methods     src/wasm.ts       browser-safe state + delta math
  → host I/O (server only)   src/io.server.ts  /sys, /proc, lspci, ip, ss, …
  → pure parsers text→JSON   rust/src/lib.rs   no fs/process access
  → UI                       src/App.tsx
```

Spec: [`.katana/machine.md`](.katana/machine.md) · agent notes:
[`AGENTS.md`](AGENTS.md) · changes: [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE). Not affiliated with Solana — the palette is an homage.
