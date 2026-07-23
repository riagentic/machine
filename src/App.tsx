// src/App.tsx — machine UI. Dense, compact, Solana-themed, reactive, alive.
//
// Every panel reads cell state directly (`machine.cpu` etc.) — signal-backed,
// re-renders only when that slice changes. No hooks, no local state. The manual
// refresh button dispatches `machine.refresh(true)` (forced, works even when
// paused); the ⏸ button toggles the live auto-poll. Schedules in app.ts poll
// the full snapshot every 2s and the CPU sampler every 1s (kata: per-second CPU
// history). A live "last refresh" age ticks via the cell polls.

import { machine } from "./wasm.ts";
import type {
  BoardInfo,
  CpuInfo,
  DimmInfo,
  DiskInfo,
  GpuInfo,
  MachineState,
  MemInfo,
  NetInfo,
  SysInfo,
} from "./wasm.ts";

// ── formatters ─────────────────────────────────────────────────────────────

const fmtBytes = (b: number): string => {
  if (!b) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

const fmtKb = (kb: number): string => fmtBytes(kb * 1024);

const pct = (n: number): string => `${n.toFixed(1)}%`;

const temp = (c: number): string => c ? `${c.toFixed(1)}°C` : "—";

const fmtMhz = (mhz: number): string =>
  !mhz
    ? "—"
    : mhz >= 1000
    ? `${(mhz / 1000).toFixed(2)} GHz`
    : `${Math.round(mhz)} MHz`;

const fmtUptime = (s: number): string => {
  if (!s) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const ago = (ms: number): string => {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
};

// Solana brand palette (+ derived status hues)
const C = {
  purple: "#9945FF",
  green: "#14F195",
  cyan: "#00C2FF",
  pink: "#DC1FFF",
  blue: "#4B7BFF",
  bg: "#07070F",
  panel: "#12121F",
  panel2: "#16162A",
  border: "#23233B",
  text: "#E4E4F0",
  dim: "#7A7A95",
  dimmer: "#4A4A60",
  warn: "#FFB020",
  bad: "#FF5C7C",
  ok: "#14F195",
  track: "#20203a",
};

// kata: partition utilization — cyan <50%, green <75%, yellow <90%, red beyond
const pctColor = (p: number): string =>
  p < 50 ? C.cyan : p < 75 ? C.green : p < 90 ? C.warn : C.bad;

// kata: temperature — cyan below 50% of max, yellow 50–90%, red beyond
const tempColor = (c: number, maxC = 100): string =>
  c < maxC * 0.5 ? C.cyan : c <= maxC * 0.9 ? C.warn : C.bad;

// kata: core box — cyan ≤25%, lime 25–50%, yellow 50–75%, red 75–100%
const coreColor = (u: number): string =>
  u <= 25 ? C.cyan : u <= 50 ? C.green : u <= 75 ? C.warn : C.bad;

const clamp = (n: number, lo = 0, hi = 100): number =>
  Math.max(lo, Math.min(hi, n));

// ── device string cleaning (lspci / lsusb) ─────────────────────────────────
// Raw lspci/lsusb text is noisy: `"Host bridge [0600]"`, `"Advanced Micro
// Devices, Inc. [AMD] [1022]"`. Strip hex id codes + quotes for readability,
// and pull a short brand out of the non-hex `[BRAND]` tag when present.

export const cleanHw = (s: string): string =>
  s
    .replace(/\s*\[[0-9a-fA-F]{2,6}\]/g, "") // drop hex ids like [0600] [1022]
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const shortVendor = (s: string): string => {
  const b = s.match(/\[([A-Za-z][\w ]{0,11})\]/); // non-hex bracket = short brand
  if (b?.[1]) return b[1].trim();
  const first = cleanHw(s).split(/[\s,]/)[0];
  return first || "—";
};

// device-class → emoji (lspci)
export const pciEmoji = (cls: string): string => {
  const c = cls.toLowerCase();
  if (/(vga|3d|display)/.test(c)) return "🎮";
  if (/(ethernet|network)/.test(c)) return "🌐";
  if (/(wireless|wifi|802\.11)/.test(c)) return "📶";
  if (/(audio|multimedia|sound)/.test(c)) return "🔊";
  if (/usb/.test(c)) return "🔌";
  if (/(sata|nvme|storage|raid|ide)/.test(c)) return "💾";
  if (/bridge/.test(c)) return "🧩";
  if (/(smbus|serial|system peripheral)/.test(c)) return "🔧";
  if (/encryption/.test(c)) return "🔐";
  return "▪";
};

// device-name → emoji (lsusb)
export const usbEmoji = (name: string): string => {
  const n = name.toLowerCase();
  if (/keyboard/.test(n)) return "⌨️";
  if (/mouse/.test(n)) return "🖱️";
  if (/hub/.test(n)) return "🔀";
  if (/(camera|webcam)/.test(n)) return "📷";
  if (/(audio|headset|microphone|speaker)/.test(n)) return "🎧";
  if (/bluetooth/.test(n)) return "🔵";
  if (/(wireless|wifi|802\.11)/.test(n)) return "📶";
  if (/(storage|disk|flash|card reader|nvme|ssd)/.test(n)) return "💾";
  if (/(ethernet|network|lan)/.test(n)) return "🌐";
  return "🔌";
};

// ── health / TODO detection ────────────────────────────────────────────────
// Pure function of current state → a ranked list of "things to fix" spanning
// hardware, software, and security. Empty list ⇒ everything nominal.

export type Sev = "crit" | "sec" | "warn" | "info";
export type Issue = { sev: Sev; icon: string; text: string };

const SEV: Record<Sev, { color: string; tag: string; rank: number }> = {
  crit: { color: C.bad, tag: "CRIT", rank: 0 },
  sec: { color: C.purple, tag: "SEC", rank: 1 },
  warn: { color: C.warn, tag: "WARN", rank: 2 },
  info: { color: C.cyan, tag: "INFO", rank: 3 },
};

// Structural inputs (a subset of the cell state) so the pure logic is testable
// with plain literals — the live `machine` cell satisfies them structurally.
export type HealthInput = Pick<
  MachineState,
  "cpu" | "mem" | "disk" | "gpu" | "net" | "sys" | "wasmAvailable"
>;
export type ReportInput = Pick<
  MachineState,
  | "cpu"
  | "mem"
  | "dimms"
  | "memSlotsTotal"
  | "board"
  | "gpu"
  | "disk"
  | "net"
  | "sys"
  | "lspci"
  | "lsusb"
>;

export function computeHealth(s: HealthInput): Issue[] {
  const out: Issue[] = [];
  // ── disk (HW) ──
  if (s.disk) {
    for (const m of s.disk.mounts) {
      if (m.used_pct >= 90) {
        out.push({
          sev: "crit",
          icon: "💽",
          text: `Free space on ${m.mount} — ${m.used_pct.toFixed(0)}% full`,
        });
      } else if (m.used_pct >= 80) {
        out.push({
          sev: "warn",
          icon: "💽",
          text: `${m.mount} filling up — ${m.used_pct.toFixed(0)}%`,
        });
      }
    }
  }
  // ── cpu temp (HW) ──
  if (s.cpu && s.cpu.temp_c > 0) {
    if (s.cpu.temp_c >= 90) {
      out.push({
        sev: "crit",
        icon: "🌡",
        text: `CPU running hot — ${s.cpu.temp_c.toFixed(0)}°C`,
      });
    } else if (s.cpu.temp_c >= 80) {
      out.push({
        sev: "warn",
        icon: "🌡",
        text: `CPU warm — ${s.cpu.temp_c.toFixed(0)}°C`,
      });
    }
  }
  // ── memory + swap (HW/SW) ──
  if (s.mem && s.mem.used_pct >= 90) {
    out.push({
      sev: "warn",
      icon: "🧬",
      text: `Memory pressure — ${s.mem.used_pct.toFixed(0)}% used`,
    });
  }
  if (s.mem && s.mem.temp_c >= 80) {
    out.push({
      sev: "warn",
      icon: "🌡",
      text: `DIMM hot — ${s.mem.temp_c.toFixed(0)}°C`,
    });
  }
  if (s.sys && s.sys.swap_total_kb > 0) {
    const sp = (s.sys.swap_used_kb / s.sys.swap_total_kb) * 100;
    if (sp >= 50) {
      out.push({
        sev: "warn",
        icon: "💾",
        text: `High swap usage — ${sp.toFixed(0)}%`,
      });
    }
  }
  // ── load vs threads (SW) ──
  if (s.sys && s.cpu && s.cpu.cores > 0 && s.sys.load1 > s.cpu.cores) {
    out.push({
      sev: "warn",
      icon: "📈",
      text: `Load high — ${s.sys.load1.toFixed(1)} over ${s.cpu.cores} threads`,
    });
  }
  // ── gpu (HW) ──
  if (s.gpu) {
    s.gpu.gpus.forEach((g, i) => {
      if (g.temp_c >= 85) {
        out.push({
          sev: "crit",
          icon: "🎮",
          text: `GPU${i} hot — ${g.temp_c.toFixed(0)}°C`,
        });
      } else if (g.temp_c >= 78) {
        out.push({
          sev: "warn",
          icon: "🎮",
          text: `GPU${i} warm — ${g.temp_c.toFixed(0)}°C`,
        });
      }
      if (g.mem_total_mb > 0 && g.mem_used_mb / g.mem_total_mb >= 0.92) {
        out.push({
          sev: "warn",
          icon: "🎞",
          text: `GPU${i} VRAM nearly full — ${
            ((g.mem_used_mb / g.mem_total_mb) * 100).toFixed(0)
          }%`,
        });
      }
    });
  }
  // ── security ──
  if (s.net && !s.net.firewall.active) {
    out.push({ sev: "sec", icon: "🛡", text: "Firewall inactive — enable it" });
  }
  if (s.net && !s.net.vpn) {
    out.push({
      sev: "sec",
      icon: "🔓",
      text: "VPN down — traffic unencrypted",
    });
  }
  // ── software / maintenance ──
  if (s.sys?.reboot_required) {
    out.push({
      sev: "warn",
      icon: "🔄",
      text: "Reboot required — updates pending",
    });
  }
  if (s.sys && s.sys.uptime_s > 30 * 86400) {
    out.push({
      sev: "info",
      icon: "⏱",
      text: `Uptime ${Math.floor(s.sys.uptime_s / 86400)}d — consider a reboot`,
    });
  }
  if (!s.wasmAvailable) {
    out.push({
      sev: "crit",
      icon: "⚙",
      text: "syscalls.wasm missing — run `deno task wasm`",
    });
  }
  return out.sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank);
}

// ── section reports (copy-to-clipboard) ─────────────────────────────────────
// Each builder turns a section's live data into a portable markdown block with
// a heading + bullets — ready to paste into an issue, forum post, or spec sheet.

const rpt = (
  heading: string,
  lines: (string | false | undefined | null)[],
): string =>
  [`## ${heading}`, ...lines.filter((l): l is string => Boolean(l))].join("\n");
const li = (k: string, v: string | number): string => `- ${k}: ${v}`;

export const cpuReport = (info: CpuInfo | null, sys: SysInfo | null): string =>
  !info ? rpt("CPU", [li("status", "no data")]) : rpt("CPU", [
    li("Model", info.model || "—"),
    li("Threads", info.cores),
    li("Utilization", pct(info.util_pct)),
    li("Temperature", temp(info.temp_c)),
    sys && sys.cpu_mhz > 0 && li(
      "Frequency",
      `${fmtMhz(sys.cpu_mhz)}${
        sys.cpu_max_mhz ? ` (max ${fmtMhz(sys.cpu_max_mhz)})` : ""
      }`,
    ),
    sys && li(
      "Load avg",
      `${sys.load1.toFixed(2)} / ${sys.load5.toFixed(2)} / ${
        sys.load15.toFixed(2)
      }`,
    ),
  ]);

export const memReport = (
  info: MemInfo | null,
  dimms: DimmInfo[],
  sys: SysInfo | null,
): string =>
  !info ? rpt("Memory", [li("status", "no data")]) : rpt("Memory", [
    li("Used", `${fmtKb(info.used_kb)} (${pct(info.used_pct)})`),
    li("Total", fmtKb(info.total_kb)),
    li("Available", fmtKb(info.available_kb)),
    info.temp_c > 0 && li("Temperature", temp(info.temp_c)),
    sys && sys.swap_total_kb > 0 &&
    li("Swap", `${fmtKb(sys.swap_used_kb)} / ${fmtKb(sys.swap_total_kb)}`),
    ...dimms.map((d, i) =>
      li(d.locator || `DIMM ${i}`, `${d.size} ${d.type} ${d.speed}`.trim())
    ),
  ]);

export const boardReport = (
  info: BoardInfo | null,
  dimmCount: number,
  slotsTotal: number,
): string =>
  !info ? rpt("Motherboard", [li("status", "no data")]) : rpt("Motherboard", [
    li("Board", `${info.board_vendor} ${info.board_name}`.trim() || "—"),
    li("Version", info.board_version || "—"),
    li("Product", info.product_name || "—"),
    li("BIOS", `${info.bios_vendor} ${info.bios_version}`.trim() || "—"),
    li("BIOS date", info.bios_date || "—"),
    info.usb_ports > 0 && li("USB ports", info.usb_ports),
    slotsTotal > 0 && li("Memory slots", `${dimmCount} / ${slotsTotal}`),
    info.temps_c.length > 0 &&
    li("Temps", info.temps_c.map((t) => temp(t)).join(", ")),
  ]);

export const gpuReport = (info: GpuInfo | null): string =>
  !info || info.gpus.length === 0
    ? rpt("GPU", [li("status", "none detected")])
    : rpt(
      "GPU",
      info.gpus.flatMap((g, i) => {
        const vram = g.mem_total_mb > 0
          ? `${(g.mem_used_mb / 1024).toFixed(1)} / ${
            (g.mem_total_mb / 1024).toFixed(1)
          } GB (${pct((g.mem_used_mb / g.mem_total_mb) * 100)})`
          : "—";
        return [
          `- GPU ${i}: ${g.name}`,
          `    · util ${pct(g.util_pct)} · temp ${
            temp(g.temp_c)
          } · vram ${vram}`,
        ];
      }),
    );

export const diskReport = (info: DiskInfo | null): string =>
  !info ? rpt("Disk", [li("status", "no data")]) : rpt("Disk", [
    li(
      "Root /",
      `${fmtBytes(info.root_used_b)} / ${fmtBytes(info.root_total_b)} (${
        pct(info.root_used_pct)
      }), ${fmtBytes(info.root_total_b - info.root_used_b)} free`,
    ),
    ...info.mounts.map((m) => li(m.mount, pct(m.used_pct))),
  ]);

export const netReport = (info: NetInfo | null): string =>
  !info ? rpt("Network", [li("status", "no data")]) : rpt("Network", [
    li("VPN", info.vpn ? "up" : "down"),
    li(
      "Firewall",
      `${info.firewall.backend} (${
        info.firewall.active ? "active" : "inactive"
      })`,
    ),
    info.speed && info.speed.link_max_mbps > 0 && li(
      "Link",
      `↓${info.speed.rx_mbps.toFixed(1)} ↑${
        info.speed.tx_mbps.toFixed(1)
      } / ${info.speed.link_max_mbps} Mbps`,
    ),
    li("Default route", info.default_route || "—"),
    li("Interfaces", summarizeAddrs(info.addrs).replace(/\n/g, "; ")),
  ]);

export const todoReport = (issues: Issue[]): string =>
  rpt(
    "Health / TODO",
    issues.length === 0
      ? [li("status", "all systems optimal")]
      : issues.map((it) => `- [${SEV[it.sev].tag}] ${it.text}`),
  );

export const lspciReport = (
  items: { class: string; vendor: string; name: string }[],
): string =>
  rpt(
    `Integrated devices (lspci · ${items.length})`,
    items.map((e) => {
      const dev = cleanHw(e.name);
      const name = dev && dev !== "Device" ? dev : cleanHw(e.class);
      return `- ${name} — ${shortVendor(e.vendor)}`;
    }),
  );

export const lsusbReport = (items: { id: string; name: string }[]): string =>
  rpt(
    `Plugged devices (lsusb · ${items.length})`,
    items.map((e) => `- ${cleanHw(e.name)} [${e.id}]`),
  );

// Whole-machine report — every section stitched together for a one-click
// "share my spec / attach to a bug report" dump.
export const fullReport = (s: ReportInput, issues: Issue[]): string => {
  const head = `# machine — system report${
    s.sys?.hostname ? ` · ${s.sys.hostname}` : ""
  }`;
  const meta = s.sys
    ? [
      s.sys.kernel && `kernel ${s.sys.kernel}`,
      s.sys.arch && `arch ${s.sys.arch}`,
      s.sys.uptime_s > 0 && `uptime ${fmtUptime(s.sys.uptime_s)}`,
    ].filter(Boolean).join(" · ")
    : "";
  return [
    head,
    meta,
    todoReport(issues),
    cpuReport(s.cpu, s.sys),
    memReport(s.mem, s.dimms, s.sys),
    boardReport(s.board, s.dimms.length, s.memSlotsTotal),
    gpuReport(s.gpu),
    diskReport(s.disk),
    netReport(s.net),
    lspciReport(s.lspci),
    lsusbReport(s.lsusb),
  ].filter(Boolean).join("\n\n");
};

// ── section icons ───────────────────────────────────────────────────────────
// kata: every section has an svg image representing its area. 16×16 stroke
// icons, currentColor so each inherits its panel's accent.
const ICON_PATHS: Record<string, string> = {
  cpu:
    "M4.5 4.5h7v7h-7z M6.5 1.5v3 M9.5 1.5v3 M6.5 11.5v3 M9.5 11.5v3 M1.5 6.5h3 M1.5 9.5h3 M11.5 6.5h3 M11.5 9.5h3",
  mem:
    "M1.5 5h13v5.5h-13z M4.5 10.5v2.5 M8 10.5v2.5 M11.5 10.5v2.5 M5.5 5v2.5 M10.5 5v2.5",
  board:
    "M1.5 1.5h13v13h-13z M4.5 4.5h4v4h-4z M11.5 11.5h1 M11.5 4.5h1 M4.5 11.5h1",
  gpu:
    "M1.5 4.5h13v7h-13z M4 11.5v2 M7 11.5v2 M10.5 8a2.5 2.5 0 1 0-5 0a2.5 2.5 0 1 0 5 0",
  disk:
    "M14.5 8a6.5 6.5 0 1 0-13 0a6.5 6.5 0 1 0 13 0 M10 8a2 2 0 1 0-4 0a2 2 0 1 0 4 0",
  net:
    "M14.5 8a6.5 6.5 0 1 0-13 0a6.5 6.5 0 1 0 13 0 M1.5 8h13 M8 1.5c-3.5 4-3.5 9 0 13 M8 1.5c3.5 4 3.5 9 0 13",
  pci: "M1.5 3.5h13v6h-13z M4 9.5v3 M11 9.5v2 M7 9.5v2.5",
  usb:
    "M8 1.5v10 M8 4.5l3.5 1.5v1.5 M8 7.5L4.5 9v1.5 M9.5 13a1.5 1.5 0 1 0-3 0a1.5 1.5 0 1 0 3 0",
  todo:
    "M2.5 2.5h11v11h-11z M4.8 5.4l1.3 1.3 2.2-2.4 M4.8 9.4l1.3 1.3 2.2-2.4 M10 5.5h2.5 M10 9.5h2.5",
};

const Icon = ({ name }: { name: string }) => (
  <svg class="panel-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d={ICON_PATHS[name] ?? ""}
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

// ── chart primitives ────────────────────────────────────────────────────────

// Linear bar with an animated width + sheen (sheen comes from CSS).
const Bar = (
  { value, max, color = C.cyan }: {
    value: number;
    max: number;
    color?: string;
  },
) => {
  const w = max > 0 ? clamp((value / max) * 100) : 0;
  return (
    <div class="bar">
      <div
        class="bar-fill"
        style={{ width: `${w}%`, backgroundColor: color, color }}
      />
    </div>
  );
};

// Segmented "equalizer" meter — a row of rectangles, lit up to the value.
// More rectangles, more alive: each cell fades in independently.
const SegBar = (
  { value, max, color = C.cyan, segs = 20 }: {
    value: number;
    max: number;
    color?: string;
    segs?: number;
  },
) => {
  const ratio = max > 0 ? clamp(value / max, 0, 1) : 0;
  const lit = Math.round(ratio * segs);
  return (
    <div class="segbar">
      {Array.from({ length: segs }, (_, i) => (
        <span
          class="seg"
          key={i}
          style={{
            backgroundColor: i < lit ? color : "var(--track)",
            color,
            opacity: i < lit ? 1 : 0.3,
          }}
        />
      ))}
    </div>
  );
};

// Radial gauge — animated ring showing a 0-100% value with a big center label.
// Solid stroke color encodes the value (so it reads at a glance); CSS animates
// the dasharray + a rotating glow behind it.
const Ring = (
  { value, color, label, size = 76 }: {
    value: number;
    color: string;
    label: string;
    size?: number;
  },
) => {
  const r = 15.915; // circumference = 100 → dasharray maps 1:1 to percent
  const p = clamp(value);
  return (
    <div class="ring-wrap" style={{ width: `${size}px`, height: `${size}px` }}>
      <span class="ring-glow" style={{ background: color }} />
      <svg class="ring" viewBox="0 0 36 36">
        <circle
          class="ring-track"
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke-width="2.6"
        />
        <circle
          class="ring-fill"
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke={color}
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-dasharray={`${p.toFixed(1)} ${(100 - p).toFixed(1)}`}
          stroke-dashoffset="25"
          style={{ color }}
        />
        <text x="18" y="17.5" text-anchor="middle" class="ring-num">
          {Math.round(p)}
          <tspan class="ring-pct">%</tspan>
        </text>
        <text x="18" y="23.5" text-anchor="middle" class="ring-lbl">
          {label}
        </text>
      </svg>
    </div>
  );
};

// Pie/donut — disk total vs used (kata: pie chart).
const Pie = ({ pct, color }: { pct: number; color: string }) => {
  const r = 15.915;
  const p = clamp(pct);
  return (
    <svg class="pie" viewBox="0 0 36 36">
      <circle
        class="pie-track"
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke-width="4"
      />
      <circle
        class="pie-fill"
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke={color}
        stroke-width="4"
        stroke-linecap="round"
        stroke-dasharray={`${p.toFixed(1)} ${(100 - p).toFixed(1)}`}
        stroke-dashoffset="25"
        style={{ color }}
      />
      <text x="18" y="17.5" text-anchor="middle" class="pie-num">
        {Math.round(p)}%
      </text>
      <text x="18" y="23" text-anchor="middle" class="pie-sub">used</text>
    </svg>
  );
};

// Sparkline — inline SVG line chart for CPU util history (kata: 100px line
// chart, per-second history). Gradient area fill, baseline grid, a moving
// current-value dot, and a soft glow — alive without being noisy.
const Sparkline = (
  { data, color = C.purple }: { data: number[]; color?: string },
) => {
  if (data.length < 2) return <div class="sparkline-empty" />;
  const w = 100;
  const h = 100;
  const max = 100;
  const pad = 4;
  const xy = (v: number, i: number): [number, number] => {
    const x = (i / (data.length - 1)) * w;
    const y = h - pad - (clamp(v, 0, max) / max) * (h - pad * 2);
    return [x, y];
  };
  const pts = data.map((v, i) => xy(v, i).map((n) => n.toFixed(1)).join(","))
    .join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const last = data[data.length - 1] ?? 0;
  const [lx, ly] = xy(last, data.length - 1);
  return (
    <svg class="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {
        /* spread: gradient attrs are valid SVG the runtime supports but aio's
          JSX typings don't declare them (see vdom-types) */
      }
      <defs>
        <linearGradient
          id="spark-fill"
          {...{ x1: "0", y1: "0", x2: "0", y2: "1" }}
        >
          <stop {...{ offset: "0%", stopColor: color, stopOpacity: "0.34" }} />
          <stop {...{ offset: "100%", stopColor: color, stopOpacity: "0" }} />
        </linearGradient>
      </defs>
      {/* quartile grid — three faint rules so the line has a frame of reference */}
      <line x1="0" y1="25" x2="100" y2="25" class="spark-grid" />
      <line x1="0" y1="50" x2="100" y2="50" class="spark-grid" />
      <line x1="0" y1="75" x2="100" y2="75" class="spark-grid" />
      <polygon points={area} fill="url(#spark-fill)" />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        stroke-width="1.6"
        vector-effect="non-scaling-stroke"
      />
      <circle
        class="spark-dot"
        cx={lx.toFixed(1)}
        cy={ly.toFixed(1)}
        r="2"
        fill={color}
      />
    </svg>
  );
};

// ── presentational primitives ───────────────────────────────────────────────

const Metric = (
  { label, value, sub, color, emoji }: {
    label: string;
    value: string;
    sub?: string;
    color?: string;
    emoji?: string;
  },
) => (
  <div class="metric">
    <div class="metric-label">{emoji ? `${emoji} ` : ""}{label}</div>
    <div class="metric-value" style={color ? { color } : undefined}>
      {value}
    </div>
    {sub && <div class="metric-sub">{sub}</div>}
  </div>
);

// Copy-to-clipboard button — writes a human-friendly report block (built per
// section) to the clipboard. Runs entirely browser-side (onClick), so it uses
// navigator.clipboard directly; brief ✓ feedback via a transient class.
const CopyButton = ({ text }: { text: string }) => (
  <button
    class="copy-btn"
    type="button"
    aria-label="Copy"
    title="copy this section as text"
    onClick={(e: Event) => {
      const btn = e.currentTarget as HTMLButtonElement | null;
      const clip = globalThis.navigator?.clipboard;
      if (!clip || !btn) return;
      clip.writeText(text).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1200);
      }).catch(() => {});
    }}
  >
    <span class="copy-ic">📋</span>
    <span class="copy-ok">✓</span>
  </button>
);

const Panel = (
  { title, accent, icon, emoji, right, span, copy, children }: {
    title: string;
    accent: string;
    icon?: string;
    emoji?: string;
    right?: unknown;
    span?: boolean;
    copy?: string;
    children: unknown;
  },
) => (
  // --accent drives all accent-aware CSS (border, hairline, title, glow)
  <div
    class={span ? "panel panel-hero" : "panel"}
    style={{ "--accent": accent }}
  >
    <div class="panel-head">
      <div class="panel-title">
        {icon && <Icon name={icon} />}
        {emoji && <span class="panel-emoji">{emoji}</span>}
        {title}
      </div>
      {(right != null || copy != null) && (
        <div class="panel-right">
          {right}
          {copy != null && <CopyButton text={copy} />}
        </div>
      )}
    </div>
    <div class="panel-body">{children}</div>
  </div>
);

const Badge = ({ text, color = C.dim, dot }: {
  text: string;
  color?: string;
  dot?: boolean;
}) => (
  <span class="badge" style={{ color, borderColor: color + "55" }}>
    {dot && <span class="badge-dot" style={{ background: color, color }} />}
    {text}
  </span>
);

const Row = (
  { k, v, mono = true, color }: {
    k: string;
    v: string;
    mono?: boolean;
    color?: string;
  },
) => (
  <div class="row">
    <span class="row-k">{k}</span>
    <span
      class="row-v"
      style={{
        ...(mono ? { fontFamily: "var(--mono)" } : {}),
        ...(color ? { color } : {}),
      }}
    >
      {v}
    </span>
  </div>
);

// A tiny inline "chip" for the header vitals + system strip.
const Chip = ({ emoji, label, value, color }: {
  emoji: string;
  label: string;
  value: string;
  color?: string;
}) => (
  <span class="chip" title={label}>
    <span class="chip-emoji">{emoji}</span>
    <span class="chip-label">{label}</span>
    <span class="chip-value" style={color ? { color } : undefined}>
      {value}
    </span>
  </span>
);

// ── panels ─────────────────────────────────────────────────────────────────

const TodoPanel = ({ issues }: { issues: Issue[] }) => {
  const worst = issues[0]?.sev;
  const accent = worst ? SEV[worst].color : C.green;
  return (
    <Panel
      title="TODO"
      accent={accent}
      icon="todo"
      emoji="🩺"
      copy={todoReport(issues)}
      right={
        <Badge
          text={issues.length ? String(issues.length) : "OK"}
          color={accent}
          dot={issues.length > 0}
        />
      }
    >
      {issues.length > 0
        ? (
          <div class="todos">
            {issues.map((it, i) => (
              <div class={`todo todo-${it.sev}`} key={i}>
                <span class="todo-icon">{it.icon}</span>
                <span class="todo-text">{it.text}</span>
                <span class="todo-sev" style={{ color: SEV[it.sev].color }}>
                  {SEV[it.sev].tag}
                </span>
              </div>
            ))}
          </div>
        )
        : <div class="todo-ok">✅ All systems optimal</div>}
    </Panel>
  );
};

const CpuPanel = (
  { info, history, sys }: {
    info: CpuInfo | null;
    history: number[];
    sys: SysInfo | null;
  },
) => (
  <Panel
    title="CPU"
    accent={C.purple}
    icon="cpu"
    emoji="🧠"
    copy={cpuReport(info, sys)}
    right={info
      ? <Badge text={`${info.cores} thr`} color={C.purple} />
      : undefined}
  >
    {info
      ? (
        <>
          <div class="model">{info.model || "—"}</div>
          <div class="cpu-top">
            <Ring
              value={info.util_pct}
              color={coreColor(info.util_pct)}
              label="util"
              size={62}
            />
            <div class="cpu-stats">
              <Metric
                label="temp"
                emoji="🌡"
                value={temp(info.temp_c)}
                color={tempColor(info.temp_c)}
              />
              <Metric
                label="freq"
                emoji="⚡"
                value={fmtMhz(sys?.cpu_mhz ?? 0)}
                sub={sys?.cpu_max_mhz
                  ? `↑ ${fmtMhz(sys.cpu_max_mhz)}`
                  : undefined}
                color={C.cyan}
              />
              <Metric
                label="load"
                emoji="📈"
                value={sys ? sys.load1.toFixed(2) : "—"}
                sub={sys
                  ? `${sys.load5.toFixed(2)}·${sys.load15.toFixed(2)}`
                  : undefined}
              />
            </div>
          </div>
          <Sparkline data={history} color={C.purple} />
          {info.cores_util.length > 0 && (
            <>
              <div class="cores">
                {/* kata: each core is a small box colored by its utilization */}
                {info.cores_util.map((u, i) => (
                  <div
                    class="core-box"
                    key={i}
                    title={`core ${i}: ${pct(u)}`}
                    style={{
                      backgroundColor: coreColor(u),
                      color: coreColor(u),
                    }}
                  />
                ))}
              </div>
              <div class="core-legend">
                <span>
                  <i style={{ background: C.cyan }} />≤25
                </span>
                <span>
                  <i style={{ background: C.green }} />50
                </span>
                <span>
                  <i style={{ background: C.warn }} />75
                </span>
                <span>
                  <i style={{ background: C.bad }} />100%
                </span>
              </div>
            </>
          )}
        </>
      )
      : <div class="empty">no cpu data</div>}
  </Panel>
);

const MemPanel = (
  { info, dimms, sys }: {
    info: MemInfo | null;
    dimms: DimmInfo[];
    sys: SysInfo | null;
  },
) => {
  const swapPct = sys && sys.swap_total_kb > 0
    ? (sys.swap_used_kb / sys.swap_total_kb) * 100
    : 0;
  return (
    <Panel
      title="MEMORY"
      accent={C.green}
      icon="mem"
      emoji="🧬"
      copy={memReport(info, dimms, sys)}
    >
      {info
        ? (
          <>
            <div class="metric-row">
              <Metric
                label="used"
                emoji="▓"
                value={fmtKb(info.used_kb)}
                color={C.green}
              />
              <Metric label="total" value={fmtKb(info.total_kb)} />
              <Metric
                label="free"
                value={fmtKb(info.available_kb)}
                color={C.cyan}
              />
              {info.temp_c > 0 && (
                <Metric
                  label="temp"
                  emoji="🌡"
                  value={temp(info.temp_c)}
                  color={tempColor(info.temp_c)}
                />
              )}
            </div>
            <SegBar
              value={info.used_pct}
              max={100}
              color={info.used_pct > 85
                ? C.bad
                : info.used_pct > 70
                ? C.warn
                : C.green}
            />
            <div class="metric-sub">{pct(info.used_pct)} in use</div>
            {sys && sys.swap_total_kb > 0 && (
              <div class="swap">
                <span class="swap-label">💾 swap</span>
                <Bar
                  value={swapPct}
                  max={100}
                  color={swapPct > 50 ? C.warn : C.blue}
                />
                <span class="swap-val">
                  {fmtKb(sys.swap_used_kb)} / {fmtKb(sys.swap_total_kb)}
                </span>
              </div>
            )}
            {dimms.length > 0 && (
              <div class="dimms">
                {dimms.map((d, i) => (
                  <div class="dimm" key={i}>
                    <span class="dimm-loc">{d.locator || `DIMM ${i}`}</span>
                    <span class="dimm-size">{d.size}</span>
                    <span class="dimm-speed">{d.speed}</span>
                    <span class="dimm-type">{d.type}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )
        : <div class="empty">no memory data</div>}
    </Panel>
  );
};

const BoardPanel = (
  { info, dimmCount, slotsTotal }: {
    info: BoardInfo | null;
    dimmCount: number;
    slotsTotal: number;
  },
) => (
  <Panel
    title="MOTHERBOARD"
    accent={C.cyan}
    icon="board"
    emoji="🧩"
    copy={boardReport(info, dimmCount, slotsTotal)}
  >
    {info
      ? (
        <>
          <Row
            k="board"
            v={`${info.board_vendor} ${info.board_name}`.trim() || "—"}
          />
          <Row k="version" v={info.board_version || "—"} />
          <Row k="product" v={info.product_name || "—"} />
          <Row
            k="bios"
            v={`${info.bios_vendor} ${info.bios_version}`.trim() || "—"}
          />
          <Row k="bios date" v={info.bios_date || "—"} />
          <Row
            k="usb ports"
            v={info.usb_ports > 0 ? String(info.usb_ports) : "—"}
          />
          <Row
            k="mem slots"
            v={slotsTotal > 0 ? `${dimmCount} / ${slotsTotal}` : "—"}
            color={slotsTotal > 0 && dimmCount >= slotsTotal ? C.warn : C.green}
          />
          {info.temps_c.length > 0 && (
            <div class="row">
              <span class="row-k">temps</span>
              <span class="row-v temps">
                {info.temps_c.map((t, i) => (
                  <span
                    class="temp-pill"
                    key={i}
                    style={{ color: tempColor(t) }}
                  >
                    {temp(t)}
                  </span>
                ))}
              </span>
            </div>
          )}
        </>
      )
      : <div class="empty">no board data</div>}
  </Panel>
);

const GpuPanel = ({ info }: { info: GpuInfo | null }) => (
  <Panel
    title="GPU"
    accent={C.pink}
    icon="gpu"
    emoji="🎮"
    copy={gpuReport(info)}
  >
    {info && info.gpus.length > 0
      ? info.gpus.map((g, i) => {
        const vramPct = g.mem_total_mb > 0
          ? (g.mem_used_mb / g.mem_total_mb) * 100
          : 0;
        return (
          <div class="gpu" key={i}>
            <div class="model">{g.name}</div>
            <div class="gpu-top">
              <Ring
                value={g.util_pct}
                color={coreColor(g.util_pct)}
                label="util"
                size={64}
              />
              <div class="gpu-stats">
                <Metric
                  label="temp"
                  emoji="🌡"
                  value={temp(g.temp_c)}
                  color={tempColor(g.temp_c)}
                />
                <Metric
                  label="vram"
                  emoji="🎞"
                  value={g.mem_total_mb
                    ? `${(g.mem_used_mb / 1024).toFixed(1)}/${
                      (g.mem_total_mb / 1024).toFixed(1)
                    }G`
                    : "—"}
                  color={vramPct > 85 ? C.bad : C.pink}
                />
              </div>
            </div>
            {g.mem_total_mb > 0 && (
              <>
                <SegBar value={vramPct} max={100} color={C.pink} />
                <div class="metric-sub">vram {pct(vramPct)}</div>
              </>
            )}
          </div>
        );
      })
      : <div class="empty">no gpu detected</div>}
  </Panel>
);

const DiskPanel = ({ info }: { info: DiskInfo | null }) => (
  <Panel
    title="DISK"
    accent={C.blue}
    icon="disk"
    emoji="💽"
    copy={diskReport(info)}
  >
    {info
      ? (
        <>
          <div class="disk-top">
            <Pie
              pct={info.root_used_pct}
              color={pctColor(info.root_used_pct)}
            />
            <div class="disk-metrics">
              <div class="metric-row">
                <Metric
                  label="used"
                  value={fmtBytes(info.root_used_b)}
                  color={pctColor(info.root_used_pct)}
                />
                <Metric label="total" value={fmtBytes(info.root_total_b)} />
              </div>
              <div class="metric-sub">
                {fmtBytes(info.root_total_b - info.root_used_b)} free on /
              </div>
            </div>
          </div>
          {info.mounts.length > 0 && (
            <div class="mounts">
              {info.mounts.map((m, i) => (
                <div class="mount" key={i}>
                  <span class="mount-mp" title={m.mount}>{m.mount}</span>
                  <Bar
                    value={m.used_pct}
                    max={100}
                    color={pctColor(m.used_pct)}
                  />
                  <span
                    class="mount-pct"
                    style={{ color: pctColor(m.used_pct) }}
                  >
                    {pct(m.used_pct)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )
      : <div class="empty">no disk data</div>}
  </Panel>
);

const NetPanel = ({ info }: { info: NetInfo | null }) => (
  <Panel
    title="NETWORK"
    accent={C.green}
    icon="net"
    emoji="🛰"
    copy={netReport(info)}
  >
    {info
      ? (
        <>
          <div class="metric-row">
            <Metric
              label="vpn"
              emoji={info.vpn ? "🔒" : "🔓"}
              value={info.vpn ? "UP" : "down"}
              color={info.vpn ? C.green : C.dim}
            />
            <Metric
              label="firewall"
              emoji="🛡"
              value={info.firewall.backend}
              sub={info.firewall.active ? "active" : "inactive"}
              color={info.firewall.active ? C.green : C.warn}
            />
          </div>
          {info.speed && info.speed.link_max_mbps > 0 && (
            <div class="net-speed">
              <div class="net-speed-row">
                <span class="net-label">↓ rx</span>
                <Bar
                  value={info.speed.rx_mbps}
                  max={info.speed.link_max_mbps}
                  color={C.green}
                />
                <span class="net-val">
                  {info.speed.rx_mbps.toFixed(1)}
                  <i>/{info.speed.link_max_mbps} Mbps</i>
                </span>
              </div>
              <div class="net-speed-row">
                <span class="net-label">↑ tx</span>
                <Bar
                  value={info.speed.tx_mbps}
                  max={info.speed.link_max_mbps}
                  color={C.cyan}
                />
                <span class="net-val">
                  {info.speed.tx_mbps.toFixed(1)}
                  <i>/{info.speed.link_max_mbps} Mbps</i>
                </span>
              </div>
            </div>
          )}
          <Row k="default route" v={info.default_route || "—"} />
          <div class="raw-json" title="ip -br addr">
            {summarizeAddrs(info.addrs)}
          </div>
        </>
      )
      : <div class="empty">no network data</div>}
  </Panel>
);

function summarizeAddrs(addrs: unknown): string {
  if (!Array.isArray(addrs)) return "—";
  const lines: string[] = [];
  for (
    const a of addrs as {
      ifname?: string;
      operstate?: string;
      addr_info?: { local?: string }[];
    }[]
  ) {
    const ifn = a.ifname ?? "?";
    const st = a.operstate ?? "?";
    const ips = (a.addr_info ?? []).map((x) => x.local).filter(Boolean).join(
      ", ",
    );
    lines.push(`${ifn} ${st}${ips ? " " + ips : ""}`);
  }
  return lines.join("\n") || "—";
}

const ListPanel = <T extends { name?: string }>({
  title,
  accent,
  icon,
  emoji,
  items,
  render,
  copy,
}: {
  title: string;
  accent: string;
  icon?: string;
  emoji?: string;
  items: T[];
  render: (item: T, i: number) => unknown;
  copy?: string;
}) => (
  <Panel
    title={title}
    accent={accent}
    icon={icon}
    emoji={emoji}
    copy={copy}
    right={<Badge text={String(items.length)} color={accent} />}
  >
    {items.length > 0
      ? (
        <div class="list">
          {items.map((item, i) => (
            <div class="list-row" key={i}>{render(item, i)}</div>
          ))}
        </div>
      )
      : <div class="empty">nothing here</div>}
  </Panel>
);

// ── header ──────────────────────────────────────────────────────────────────

// Animated chip/hex brand mark — an SVG logo with a slow-sweeping accent stroke.
const BrandMark = () => (
  <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
    <defs>
      <linearGradient
        id="brand-grad"
        {...{ x1: "0", y1: "0", x2: "1", y2: "1" }}
      >
        <stop {...{ offset: "0%", stopColor: C.purple }} />
        <stop {...{ offset: "50%", stopColor: C.green }} />
        <stop {...{ offset: "100%", stopColor: C.cyan }} />
      </linearGradient>
    </defs>
    <rect
      x="6"
      y="6"
      width="20"
      height="20"
      rx="5"
      fill="none"
      stroke="url(#brand-grad)"
      stroke-width="2.2"
      class="brand-ring"
    />
    <rect
      x="12.5"
      y="12.5"
      width="7"
      height="7"
      rx="1.5"
      fill="url(#brand-grad)"
      class="brand-core"
    />
    {[10, 16, 22].map((p) => (
      <g key={p}>
        <line
          x1={p}
          y1="1.5"
          x2={p}
          y2="6"
          stroke="url(#brand-grad)"
          stroke-width="1.6"
        />
        <line
          x1={p}
          y1="26"
          x2={p}
          y2="30.5"
          stroke="url(#brand-grad)"
          stroke-width="1.6"
        />
        <line
          x1="1.5"
          y1={p}
          x2="6"
          y2={p}
          stroke="url(#brand-grad)"
          stroke-width="1.6"
        />
        <line
          x1="26"
          y1={p}
          x2="30.5"
          y2={p}
          stroke="url(#brand-grad)"
          stroke-width="1.6"
        />
      </g>
    ))}
  </svg>
);

// ── root ────────────────────────────────────────────────────────────────────

export default function App() {
  const s = machine;
  const age = ago(s.lastRefresh);
  const refreshing = s.refreshing;
  const paused = s.paused;
  const sys = s.sys;
  const theme = s.theme;

  const cpuUtil = s.cpu?.util_pct ?? 0;
  const memUtil = s.mem?.used_pct ?? 0;
  const gpuUtil = s.gpu?.gpus[0]?.util_pct ?? 0;
  const cpuTemp = s.cpu?.temp_c ?? 0;
  const issues = computeHealth(s);

  return (
    <div class="app" data-theme={theme}>
      <header class="header">
        <div class="brand">
          <BrandMark />
          <div class="brand-text">
            <span class="brand-name">machine</span>
            <span class="brand-sub">
              {sys?.hostname ? `🖥 ${sys.hostname}` : "hardware deck"}
            </span>
          </div>
        </div>

        <div class="vitals">
          <Chip
            emoji="🧠"
            label="cpu"
            value={pct(cpuUtil)}
            color={coreColor(cpuUtil)}
          />
          <Chip
            emoji="🧬"
            label="mem"
            value={pct(memUtil)}
            color={coreColor(memUtil)}
          />
          {s.gpu && s.gpu.gpus.length > 0 && (
            <Chip
              emoji="🎮"
              label="gpu"
              value={pct(gpuUtil)}
              color={coreColor(gpuUtil)}
            />
          )}
          <Chip
            emoji="🌡"
            label="temp"
            value={temp(cpuTemp)}
            color={tempColor(cpuTemp)}
          />
        </div>

        <div class="status">
          {s.wasmAvailable
            ? <Badge text="wasm" color={C.green} dot />
            : <Badge text="wasm off" color={C.warn} dot />}
          <span class="age" title="last refresh">🕓 {age}</span>
          <button
            class="ctrl"
            type="button"
            aria-label="CopyAll"
            title="copy full system report"
            onClick={(e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement | null;
              const clip = globalThis.navigator?.clipboard;
              if (!clip || !btn) return;
              clip.writeText(fullReport(s, issues)).then(() => {
                btn.classList.add("copied-flash");
                setTimeout(() => btn.classList.remove("copied-flash"), 1000);
              }).catch(() => {});
            }}
          >
            📋
          </button>
          <button
            class="ctrl"
            type="button"
            aria-label="Theme"
            title={theme === "dark" ? "switch to light" : "switch to dark"}
            onClick={() => machine.toggleTheme()}
          >
            {theme === "dark" ? "☀" : "🌙"}
          </button>
          <button
            class={paused ? "ctrl ctrl-on" : "ctrl"}
            type="button"
            aria-label="Pause"
            title={paused ? "resume auto-refresh" : "pause auto-refresh"}
            onClick={() => machine.togglePause()}
          >
            {paused ? "▶" : "⏸"}
          </button>
          <button
            class="refresh"
            type="button"
            aria-label="Refresh"
            title="refresh now"
            onClick={() => machine.refresh(true)}
            disabled={refreshing}
          >
            ↻
          </button>
        </div>
      </header>

      {sys && (
        <div class="sysbar">
          <Chip emoji="🐧" label="kernel" value={sys.kernel || "—"} />
          <Chip emoji="🧱" label="arch" value={sys.arch || "—"} />
          <Chip
            emoji="⏱"
            label="uptime"
            value={fmtUptime(sys.uptime_s)}
            color={C.green}
          />
          <Chip
            emoji="📊"
            label="load"
            value={`${sys.load1.toFixed(2)} · ${sys.load5.toFixed(2)} · ${
              sys.load15.toFixed(2)
            }`}
          />
          {sys.procs_total > 0 && (
            <Chip
              emoji="🧵"
              label="procs"
              value={`${sys.procs_running}/${sys.procs_total}`}
            />
          )}
        </div>
      )}

      <main class="grid">
        <TodoPanel issues={issues} />
        <CpuPanel info={s.cpu} history={s.cpuUtilHistory} sys={sys} />
        <MemPanel info={s.mem} dimms={s.dimms} sys={sys} />
        <BoardPanel
          info={s.board}
          dimmCount={s.dimms.length}
          slotsTotal={s.memSlotsTotal}
        />
        <GpuPanel info={s.gpu} />
        <DiskPanel info={s.disk} />
        <NetPanel info={s.net} />
        <ListPanel
          title="LSPCI"
          accent={C.purple}
          icon="pci"
          emoji="🔗"
          items={s.lspci}
          copy={lspciReport(s.lspci)}
          render={(e) => {
            // AMD/others often report the device as a bare "Device [id]"; the
            // class ("Host bridge", "VGA compatible controller") is the useful
            // label there, so fall back to it.
            const dev = cleanHw(e.name);
            const name = dev && dev !== "Device" ? dev : cleanHw(e.class);
            return (
              <>
                <span class="dev-emoji">{pciEmoji(e.class)}</span>
                <span
                  class="dev-name"
                  title={`${cleanHw(e.class)} · ${cleanHw(e.vendor)}`}
                >
                  {name}
                </span>
                <span class="dev-tag">{shortVendor(e.vendor)}</span>
              </>
            );
          }}
        />
        <ListPanel
          title="LSUSB"
          accent={C.pink}
          icon="usb"
          emoji="🔌"
          items={s.lsusb}
          copy={lsusbReport(s.lsusb)}
          render={(e) => (
            <>
              <span class="dev-emoji">{usbEmoji(e.name)}</span>
              <span class="dev-name" title={e.name}>{cleanHw(e.name)}</span>
              <span class="dev-tag mono">{e.id}</span>
            </>
          )}
        />
      </main>
    </div>
  );
}
