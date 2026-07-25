// src/wasm.ts — the `machine` cell: types + state shape + the async `refresh`
// method. This file is imported by BOTH src/app.ts (server) and src/App.tsx
// (browser), so it MUST be browser-safe — no `Deno.*`, no `@std/*`, no fs.
//
// All server-only I/O (WASM loading, file reads, command spawning, platform
// detection) lives in src/io.server.ts. The `refresh` method dynamic-imports
// it, so the browser bundle never reaches Deno APIs (aio marks `*.server.ts`
// dynamic imports as external — see dep/aio/docs/build/imports.md). This is
// the #1 aio gotcha: a server-only import in a cell/index reaches the browser
// and blanks the screen with "Deno is not defined".

import { cell } from "aio";

// ── types matching the Rust JSON shape ─────────────────────────────────────

export type CpuInfo = {
  model: string;
  cores: number;
  stat: string;
  core_stats: string[]; // per-core /proc/stat lines (Linux)
  temp_c: number;
  util_pct: number; // 0-100, aggregate, computed from delta of two samples
  cores_util: number[]; // 0-100 per core, computed from delta of two samples
};

export type MemInfo = {
  total_kb: number;
  available_kb: number;
  used_kb: number;
  used_pct: number;
  temp_c: number; // hottest DIMM sensor (spd5118/jc42), host-stamped; 0 = none
};

export type DimmInfo = {
  locator: string;
  size: string;
  speed: string;
  type: string;
};

export type BoardInfo = {
  board_name: string;
  board_vendor: string;
  board_version: string;
  bios_vendor: string;
  bios_version: string;
  bios_date: string;
  product_name: string;
  temps_c: number[];
  usb_ports: number; // host-stamped after parse (Rust JSON has no such field)
};

export type GpuInfo = {
  gpus: {
    name: string;
    temp_c: number;
    util_pct: number;
    mem_total_mb: number;
    mem_used_mb: number;
  }[];
};

export type DiskInfo = {
  root_total_b: number;
  root_used_b: number;
  root_used_pct: number;
  mounts: {
    mount: string;
    total_b: number;
    used_b: number;
    used_pct: number;
  }[];
};

export type LspciEntry = { class: string; vendor: string; name: string };
export type LsusbEntry = { bus: string; dev: string; id: string; name: string };

export type NetInfo = {
  addrs: unknown;
  links: unknown;
  vpn: boolean;
  firewall: { backend: string; active: boolean };
  default_route: string;
  speed: { link_max_mbps: number; rx_mbps: number; tx_mbps: number };
};

// Security posture — parsed by the Rust sys_sec syscall. Checks whose input
// is unavailable are OMITTED by the parser (never reported as failing).
export type SecCheck = {
  id: string;
  label: string;
  value: string;
  ok: boolean;
  hint: string;
};
export type SecPort = {
  proto: string;
  addr: string;
  port: number;
  process: string;
  exposed: boolean; // bound beyond loopback — reachable from the network
};
export type SecProc = {
  pid: number;
  user: string;
  cmd: string;
  reason: string;
};
export type SecInfo = {
  ports: SecPort[];
  procs: SecProc[];
  checks: SecCheck[];
};

// Host identity + live vitals — collected host-side (no WASM parser). Every
// field is best-effort; 0/"" means "unavailable", never an error.
export type SysInfo = {
  hostname: string;
  kernel: string;
  arch: string;
  os: string;
  uptime_s: number;
  load1: number;
  load5: number;
  load15: number;
  procs_running: number;
  procs_total: number;
  cpu_mhz: number; // current average across cores
  cpu_max_mhz: number; // cpufreq max (boost ceiling)
  swap_total_kb: number;
  swap_used_kb: number;
  reboot_required: boolean; // pending kernel/package update needs a reboot
  governor: string; // cpufreq scaling governor ("" = unavailable)
};

// ── cell: machine ─────────────────────────────────────────────────────────
// The single source of truth for hardware state. `refresh` is called on a
// static schedule (every 2s, wired in src/app.ts) and on demand. All syscalls
// are awaited in parallel inside collectAll() so the loop never blocks on a
// single slow read.

export type MachineState = {
  lastRefresh: number; // epoch ms
  refreshing: boolean;
  refreshingCpu: boolean; // re-entrancy guard for the 1s CPU sampler
  paused: boolean; // when true, scheduled polls skip; manual refresh still runs
  theme: "dark" | "light"; // UI theme, toggled from the header
  wasmAvailable: boolean;
  prevCpuStat: string; // previous /proc/stat aggregate line — for util delta
  prevCpuCoresStat: string[]; // previous per-core lines — for per-core util delta
  prevNetBytes: { iface: string; rx: number; tx: number; ts: number } | null;
  cpuUtilHistory: number[]; // last 60 aggregate util_pct samples (for sparkline)
  cpu: CpuInfo | null;
  mem: MemInfo | null;
  dimms: DimmInfo[];
  memSlotsTotal: number; // total physical slots (0 = unknown / no dmidecode)
  board: BoardInfo | null;
  gpu: GpuInfo | null;
  disk: DiskInfo | null;
  lspci: LspciEntry[];
  lsusb: LsusbEntry[];
  net: NetInfo | null;
  sys: SysInfo | null;
  sec: SecInfo | null;
};

// Compute CPU utilization % from two consecutive /proc/stat "cpu" lines.
// Format: "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
// util% = 100 * (1 - idle_delta / total_delta). Returns 0 on first sample.
// Pure — safe for the browser bundle (the cell calls it with state it already
// holds; no Deno access here).
function cpuUtilPct(prev: string, cur: string): number {
  const parse = (s: string) =>
    s.split(/\s+/).slice(1).map((n) => parseInt(n) || 0);
  const a = parse(prev);
  const b = parse(cur);
  if (a.length < 4 || b.length < 4) return 0;
  const totalDelta = b.reduce((sum, v, i) => sum + (v - (a[i] ?? 0)), 0);
  if (totalDelta <= 0) return 0;
  const idleDelta = (b[3] ?? 0) - (a[3] ?? 0);
  return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
}

// Per-core utilization: same formula applied to each "cpuN" line pair.
function coresUtilPct(prev: string[], cur: string[]): number[] {
  return cur.map((cLine, i) => cpuUtilPct(prev[i] ?? "", cLine));
}

export const machine = cell("machine", {
  state: {
    lastRefresh: 0,
    refreshing: false,
    refreshingCpu: false,
    paused: false,
    theme: "dark",
    wasmAvailable: true,
    prevCpuStat: "",
    prevCpuCoresStat: [] as string[],
    prevNetBytes: null as MachineState["prevNetBytes"],
    cpuUtilHistory: [] as number[],
    cpu: null,
    mem: null,
    dimms: [] as DimmInfo[],
    memSlotsTotal: 0,
    board: null,
    gpu: null,
    disk: null,
    lspci: [],
    lsusb: [],
    net: null,
    sys: null,
    sec: null,
  } as MachineState,
  methods: {
    // `force` is passed by the manual refresh button so a paused app can still
    // be refreshed on demand; scheduled polls call with no arg and are gated.
    async refresh(s, force?: boolean) {
      if (s.refreshing) return;
      if (s.paused && !force) return;
      s.refreshing = true;
      try {
        // Dynamic-import the server-only I/O layer. The `.server.ts` suffix
        // makes aio's esbuild bundle mark this import external — the browser
        // never loads it, never sees Deno.*. Runs only on the server.
        const io = await import("./io.server.ts");
        const snap = await io.collectAll();
        // CPU utilization from the delta of two /proc/stat samples (Linux).
        // The Rust parser passes the raw stat line through; we compute the %
        // here (host-side) and stamp it onto the CPU info before storing.
        if (snap.cpu && io.PLATFORM === "linux") {
          // Deliberate post-await read: /proc/stat counters are cumulative, so
          // a delta against a prev sample the 1s CPU poll may have refreshed
          // mid-await stays correct (reading the freshest prev is intended).
          snap.cpu.util_pct = cpuUtilPct(s.prevCpuStat, snap.cpu.stat);
          s.prevCpuStat = snap.cpu.stat;
          snap.cpu.cores_util = coresUtilPct(
            s.prevCpuCoresStat,
            snap.cpu.core_stats,
          );
          s.prevCpuCoresStat = snap.cpu.core_stats;
        }
        // Net speed: the I/O layer passes raw rx/tx BYTE COUNTS in
        // rx_mbps/tx_mbps (misnamed for transit — the Rust parser just forwards
        // them). The cell computes the actual Mbps rate from the delta between
        // samples, then stashes the raw counts for the next refresh.
        if (snap.net && snap.net.speed) {
          const rawRx = snap.net.speed.rx_mbps; // raw bytes (see io.server.ts)
          const rawTx = snap.net.speed.tx_mbps;
          if (s.prevNetBytes) {
            const dt = (Date.now() - s.prevNetBytes.ts) / 1000;
            if (dt > 0) {
              snap.net.speed.rx_mbps = Math.max(
                0,
                ((rawRx - s.prevNetBytes.rx) * 8) / dt / 1e6,
              );
              snap.net.speed.tx_mbps = Math.max(
                0,
                ((rawTx - s.prevNetBytes.tx) * 8) / dt / 1e6,
              );
            } else {
              snap.net.speed.rx_mbps = 0;
              snap.net.speed.tx_mbps = 0;
            }
          } else {
            // first sample — no rate yet
            snap.net.speed.rx_mbps = 0;
            snap.net.speed.tx_mbps = 0;
          }
          s.prevNetBytes = { iface: "", rx: rawRx, tx: rawTx, ts: Date.now() };
        }
        s.cpu = snap.cpu;
        s.mem = snap.mem;
        s.dimms = snap.dimms;
        s.memSlotsTotal = snap.memSlotsTotal;
        s.board = snap.board;
        s.gpu = snap.gpu;
        s.disk = snap.disk;
        s.lspci = snap.lspci;
        s.lsusb = snap.lsusb;
        s.net = snap.net;
        s.sys = snap.sys;
        s.sec = snap.sec;
        // (CPU history is owned by refreshCpu — the 1s sampler — so the
        // sparkline stays strictly per-second; no push here.)
        const anyNull = !snap.cpu || !snap.mem || !snap.board || !snap.gpu ||
          !snap.disk || !snap.net;
        s.wasmAvailable = !anyNull;
        s.lastRefresh = Date.now();
      } finally {
        s.refreshing = false;
      }
    },
    // Light 1s sampler: CPU only (kata: CPU line chart shows history per
    // second). The full refresh stays at 2s — spawning lspci/df/dmidecode
    // every second would waste host cycles for panels that barely change.
    // /proc/stat counters are cumulative, so interleaved deltas with the
    // full refresh stay correct regardless of interval.
    async refreshCpu(s) {
      if (s.refreshingCpu || s.paused) return;
      s.refreshingCpu = true;
      try {
        const io = await import("./io.server.ts");
        const snap = await io.cpu();
        if (!snap) return;
        if (io.PLATFORM === "linux") {
          // Deliberate post-await read (see refresh): cumulative counters keep
          // the delta correct even if the 2s poll refreshed prevCpuStat.
          snap.util_pct = cpuUtilPct(s.prevCpuStat, snap.stat);
          s.prevCpuStat = snap.stat;
          snap.cores_util = coresUtilPct(s.prevCpuCoresStat, snap.core_stats);
          s.prevCpuCoresStat = snap.core_stats;
        }
        s.cpu = snap;
        // keep last 60 samples — .slice() (not spread): live async state
        // doesn't expose Symbol.iterator; slice returns a plain snapshot array.
        const hist = Array.isArray(s.cpuUtilHistory)
          ? s.cpuUtilHistory.slice(-59)
          : [];
        hist.push(snap.util_pct);
        s.cpuUtilHistory = hist;
      } finally {
        s.refreshingCpu = false;
      }
    },
    // Toggle the live auto-poll. Resuming kicks an immediate forced refresh so
    // the UI doesn't wait up to 2s for the next scheduled tick.
    togglePause(s) {
      s.paused = !s.paused;
      if (!s.paused) machine.refresh(true);
    },
    toggleTheme(s) {
      s.theme = s.theme === "dark" ? "light" : "dark";
    },
  },
});
