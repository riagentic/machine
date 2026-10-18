// src/App.tsx — machine UI. Dense, compact, Solana-themed, reactive, alive.
//
// Every panel reads cell state directly (`machine.cpu` etc.) — signal-backed,
// re-renders only when that slice changes. No hooks, no local state. The manual
// refresh button dispatches `machine.refresh(true)` (forced, works even when
// paused); the ⏸ button toggles the live auto-poll. Schedules in app.ts poll
// the full snapshot every 2s and the CPU sampler every 1s (kata: per-second CPU
// history). A live "last refresh" age ticks via the cell polls.

import { machine, type View } from "./wasm.ts";
import type {
  BoardInfo,
  CpuInfo,
  DimmInfo,
  DiskInfo,
  GpuInfo,
  MachineState,
  MemInfo,
  NetInfo,
  SecInfo,
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

// Unified palette. ONE brand accent (violet) drives every panel's icon/title/
// border, so the deck reads as a single product rather than a rainbow of
// per-section hues. Status colours are reserved for semantics (temperature,
// utilisation, posture) — green=good, amber=caution, red=alert, blue=info.
// Values are CSS vars so `.app[data-theme]` swaps them (style.css palettes).
const C = {
  accent: "var(--accent)", // single brand accent — all panel icons/titles/borders
  green: "var(--green)", // ok / nominal
  lime: "var(--lime)", // kata: cores 25–50%
  cyan: "var(--cyan)", // info / cool
  blue: "var(--blue)", // info-neutral (secondary)
  warn: "var(--warn)", // caution
  bad: "var(--bad)", // alert
  dim: "var(--dim)",
};

// translucent tint of a palette colour (borders) — works on var() values
const tint = (color: string): string =>
  `color-mix(in srgb, ${color} 33%, transparent)`;

// kata: partition utilization — cyan <50%, green <75%, yellow <90%, red beyond
const pctColor = (p: number): string =>
  p < 50 ? C.cyan : p < 75 ? C.green : p < 90 ? C.warn : C.bad;

// Temperature thresholds (°C) — the single source for tempColor AND
// computeHealth, so red ⇔ CRIT. kata: cyan below 50% of max, yellow 50–90%,
// red beyond — crit IS 90% of max, so cool ends at crit × 5/9.
type TempLimits = { warn: number; crit: number };
const TEMP: Record<"cpu" | "gpu" | "dimm", TempLimits> = {
  cpu: { warn: 80, crit: 90 },
  gpu: { warn: 78, crit: 85 },
  dimm: { warn: 80, crit: 90 },
};
const tempColor = (c: number, t: TempLimits = TEMP.cpu): string =>
  c < (t.crit * 5) / 9 ? C.cyan : c < t.crit ? C.warn : C.bad;

// kata: core box — cyan ≤25%, lime 25–50%, yellow 50–75%, red 75–100%
const coreColor = (u: number): string =>
  u <= 25 ? C.cyan : u <= 50 ? C.lime : u <= 75 ? C.warn : C.bad;

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
    .trim()
    .replace(/^\[\]$/, ""); // a lone empty bracket pair is noise, not a name

export const shortVendor = (s: string): string => {
  const b = s.match(/\[([A-Za-z][\w ]{0,11})\]/); // non-hex bracket = short brand
  if (b?.[1]) return b[1].trim();
  const first = cleanHw(s).split(/[\s,]/)[0];
  // A bare bracket pair ("[]") or empty token is not a vendor — show "—".
  return first && first !== "[]" ? first : "—";
};

// device-class → ICON_PATHS key (lspci)
export const pciIcon = (cls: string): string => {
  const c = cls.toLowerCase();
  if (/(vga|3d|display)/.test(c)) return "gpu";
  if (/(wireless|wifi|802\.11)/.test(c)) return "wifi";
  if (/(ethernet|network)/.test(c)) return "net";
  if (/(audio|multimedia|sound)/.test(c)) return "audio";
  if (/usb/.test(c)) return "usb";
  if (/(sata|nvme|storage|raid|ide)/.test(c)) return "storage";
  if (/bridge/.test(c)) return "chip";
  if (/(smbus|serial|system peripheral)/.test(c)) return "cog";
  if (/encryption/.test(c)) return "key";
  return "pci";
};

// device-name → ICON_PATHS key (lsusb)
export const usbIcon = (name: string): string => {
  const n = name.toLowerCase();
  if (/keyboard/.test(n)) return "keyboard";
  if (/(camera|webcam)/.test(n)) return "camera";
  if (/(audio|headset|microphone|speaker)/.test(n)) return "headset";
  if (/bluetooth/.test(n)) return "bluetooth";
  if (/(wireless|wifi|802\.11)/.test(n)) return "wifi";
  if (/(storage|disk|flash|card reader|nvme|ssd)/.test(n)) return "storage";
  if (/(ethernet|network|lan)/.test(n)) return "net";
  return "usb";
};

// ── health / TODO detection ────────────────────────────────────────────────
// Pure function of current state → a ranked list of "things to fix" spanning
// hardware, software, and security. Empty list ⇒ everything nominal.

export type Sev = "crit" | "sec" | "warn" | "info";
export type Issue = { sev: Sev; icon: string; text: string };

const SEV: Record<Sev, { color: string; tag: string; rank: number }> = {
  crit: { color: C.bad, tag: "CRIT", rank: 0 },
  sec: { color: C.accent, tag: "SEC", rank: 1 },
  warn: { color: C.warn, tag: "WARN", rank: 2 },
  info: { color: C.cyan, tag: "INFO", rank: 3 },
};

// Structural inputs (a subset of the cell state) so the pure logic is testable
// with plain literals — the live `machine` cell satisfies them structurally.
export type HealthInput = Pick<
  MachineState,
  "cpu" | "mem" | "disk" | "gpu" | "net" | "sys" | "sec" | "wasmAvailable"
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
  | "sec"
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
    if (s.cpu.temp_c >= TEMP.cpu.crit) {
      out.push({
        sev: "crit",
        icon: "🌡",
        text: `CPU running hot — ${s.cpu.temp_c.toFixed(0)}°C`,
      });
    } else if (s.cpu.temp_c >= TEMP.cpu.warn) {
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
  if (s.mem && s.mem.temp_c >= TEMP.dimm.warn) {
    out.push({
      sev: s.mem.temp_c >= TEMP.dimm.crit ? "crit" : "warn",
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
      if (g.temp_c >= TEMP.gpu.crit) {
        out.push({
          sev: "crit",
          icon: "🎮",
          text: `GPU${i} hot — ${g.temp_c.toFixed(0)}°C`,
        });
      } else if (g.temp_c >= TEMP.gpu.warn) {
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
  if (s.sec) {
    // Compromise indicators are critical; posture gaps are SEC suggestions.
    for (const p of s.sec.procs) {
      out.push({
        sev: "crit",
        icon: "☠",
        text: `Suspicious process ${p.pid} (${p.user}) — ${p.reason}`,
      });
    }
    const exposed = s.sec.ports.filter((p) => p.exposed);
    if (exposed.length > 0) {
      const names = [
        ...new Set(exposed.map((p) => p.process || String(p.port))),
      ];
      out.push({
        sev: "sec",
        icon: "🚪",
        text: `${exposed.length} port${
          exposed.length > 1 ? "s" : ""
        } open to the network — ${names.slice(0, 4).join(", ")}${
          names.length > 4 ? "…" : ""
        }`,
      });
    }
    // High-impact single checks get their own line; the rest aggregate.
    const failed = s.sec.checks.filter((c) => !c.ok);
    const loud = ["ssh_root", "ssh_pass", "secboot", "luks", "updates"];
    for (const c of failed.filter((c) => loud.includes(c.id))) {
      out.push({
        sev: c.id === "updates" ? "warn" : "sec",
        icon: c.id === "updates" ? "📦" : "🔑",
        text: `${c.label}: ${c.value} — ${c.hint}`,
      });
    }
    const quiet = failed.filter((c) => !loud.includes(c.id));
    if (quiet.length > 0) {
      out.push({
        sev: "sec",
        icon: "🧱",
        text: `${quiet.length} kernel hardening gap${
          quiet.length > 1 ? "s" : ""
        } — ${quiet.map((c) => c.label).join(", ")}`,
      });
    }
  }
  // ── software / maintenance ──
  if (s.sys?.reboot_required) {
    out.push({
      sev: "warn",
      icon: "🔄",
      text: "Reboot required — updates pending",
    });
  }
  if (s.net && s.net.default_route === "") {
    out.push({
      sev: "warn",
      icon: "🛰",
      text: "No default route — machine looks offline",
    });
  }
  if (s.sys && s.cpu && s.cpu.cores > 0 && s.sys.load15 > s.cpu.cores) {
    out.push({
      sev: "warn",
      icon: "🐢",
      text: `Sustained load — 15m avg ${
        s.sys.load15.toFixed(1)
      } over ${s.cpu.cores} threads`,
    });
  }
  if (s.sys && s.sys.swap_total_kb === 0 && s.mem && s.mem.used_pct >= 70) {
    out.push({
      sev: "info",
      icon: "🧯",
      text: "No swap configured — OOM kills hit without warning",
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
          } GiB (${pct((g.mem_used_mb / g.mem_total_mb) * 100)})`
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
      }), ${fmtBytes(info.root_avail_b)} free`,
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
    info.speed && li(
      "Link",
      `↓${info.speed.rx_mbps.toFixed(1)} ↑${info.speed.tx_mbps.toFixed(1)}${
        info.speed.link_max_mbps > 0 ? ` / ${info.speed.link_max_mbps}` : ""
      } Mbps`,
    ),
    li("Default route", info.default_route || "—"),
    li("Interfaces", summarizeAddrs(info.addrs).replace(/\n/g, "; ")),
  ]);

// ── security score ──────────────────────────────────────────────────────────
// Pure 0-100 posture score. Unknown never punishes: with zero checks the
// checks slice contributes its full weight (a locked-down box that exposes
// nothing scores well, it doesn't fail for being unreadable).
//   checks 50 · ports 20 (−4/exposed) · clean procs 15 · firewall 10 · vpn 5
export const secScore = (sec: SecInfo | null, net: NetInfo | null): number => {
  if (!sec) return 0;
  const total = sec.checks.length;
  const passed = sec.checks.filter((c) => c.ok).length;
  const checkPts = total > 0 ? (passed / total) * 50 : 50;
  const exposed = sec.ports.filter((p) => p.exposed).length;
  const portPts = Math.max(0, 20 - exposed * 4);
  const procPts = sec.procs.length === 0 ? 15 : 0;
  const fwPts = net?.firewall.active ? 10 : 0;
  const vpnPts = net?.vpn ? 5 : 0;
  return Math.round(checkPts + portPts + procPts + fwPts + vpnPts);
};

export const secReport = (sec: SecInfo | null, net: NetInfo | null): string =>
  !sec ? rpt("Security", [li("status", "no data")]) : rpt("Security", [
    li("Score", `${secScore(sec, net)}/100`),
    ...sec.checks.map((c) =>
      li(
        `${c.ok ? "✓" : "✗"} ${c.label}`,
        `${c.value}${c.ok ? "" : ` — ${c.hint}`}`,
      )
    ),
    li(
      "Listening ports",
      sec.ports.length === 0
        ? "none"
        : sec.ports.map((p) =>
          `${p.proto}/${p.port}${p.process ? ` ${p.process}` : ""}${
            p.exposed ? " (exposed)" : ""
          }`
        ).join(", "),
    ),
    sec.procs.length > 0 &&
    `- Suspicious processes:\n${
      sec.procs.map((p) =>
        `    · pid ${p.pid} ${p.user}: ${p.cmd} — ${p.reason}`
      )
        .join("\n")
    }`,
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
    secReport(s.sec, s.net),
    lspciReport(s.lspci),
    lsusbReport(s.lsusb),
  ].filter(Boolean).join("\n\n");
};

// ── section icons ───────────────────────────────────────────────────────────
// kata: every section has an svg image representing its area. 16×16 stroke
// icons, currentColor so each inherits its panel's accent.
// Unified SVG icon set — every glyph is a 16×16 1.5-unit stroke path drawn with
// the SAME visual language (round caps/joins, open strokes), so panels, chips,
// metrics, buttons and lists all read as one coherent product. `currentColor`
// inherits the accent. No emoji.
const ICON_PATHS: Record<string, string> = {
  // sections
  cpu:
    "M3.5 3.5h9v9h-9z M6 1.5v2 M10 1.5v2 M6 12.5v2 M10 12.5v2 M1.5 6h2 M1.5 10h2 M12.5 6h2 M12.5 10h2",
  mem: "M2 4.5h12v7H2z M2 6.5h12 M5 11.5v3 M8 11.5v3 M11 11.5v3",
  board:
    "M1.5 1.5h13v13h-13z M5 5h6v6H5z M5 13.5v1 M11 13.5v1 M1.5 9h1.5 M13 9h1.5",
  gpu:
    "M2 4.5h12v6H2z M4 10.5v3 M7.5 10.5v3 M11 10.5v3 M8 7.5a1.5 1.5 0 1 0 0 .001",
  disk:
    "M15 7.5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z M10 7.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  net:
    "M15 7.5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z M1.5 7.5h13 M8 1.5c-3.5 3.5-3.5 10 0 13.5 M8 1.5c3.5 3.5 3.5 10 0 13.5",
  pci:
    "M1.5 3.5h13v6h-13z M4 9.5v3 M8 9.5v2.5 M12 9.5v3 M5.5 6h.01 M8 6h.01 M10.5 6h.01",
  usb: "M8 1.5v11 M8 4l3 1.5v1.5L8 6.5 5 7v1.5L8 7 M8 12.5l1.5 1.5h-3z",
  todo: "M2.5 2.5h11v11h-11z M5 6h6 M5 9h4 M5 12h2",
  all: "M2 2h5v5H2z M9 2h5v5H9z M2 9h5v5H2z M9 9h5v5H9z",
  sec:
    "M8 1.5l5.5 2v4c0 3.4-2.3 5.9-5.5 7-3.2-1.1-5.5-3.6-5.5-7v-4z M6 8l1.4 1.4 2.6-2.8",
  // metric / status glyphs
  temp:
    "M8 1.5a1 1 0 0 0-1 1v6.3a3.5 3.5 0 1 0 2 0V2.5a1 1 0 0 0-1-1z M8 13.5v.01",
  bolt: "M8.5 1.5L3.5 9h4l-1 5.5L12 7H8l.5-5.5z",
  load: "M2 13.5h12 M4 13.5V8 M8 13.5V4 M12 13.5V6",
  vram: "M2 2h12v12H2z M2 5h12 M5 8h2 M5 11h2",
  ram: "M2 4h12v3H2z M2 9h12v3H2z M5 7v2 M9 7v2",
  swap: "M8 1.5v9 M8 10.5L5 8 M8 10.5L11 8 M13 6.5V12a1.5 1.5 0 0 1-1.5 1.5h-7",
  clock: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M8 4.5V8l2.5 1.5",
  pulse: "M1.5 8h3l2-4 3 8 2-4h3",
  shield: "M8 1.5l5.5 2v4c0 3.4-2.3 5.9-5.5 7-3.2-1.1-5.5-3.6-5.5-7v-4z",
  lock: "M4.5 7.5V6a3.5 3.5 0 0 1 7 0v1.5 M2.5 7.5h11V14h-11z M8 10.5v1",
  unlock: "M4.5 7.5V6a3.5 3.5 0 0 1 6.6-1.5 M2.5 7.5h11V14h-11z M8 10.5v1",
  globe:
    "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M1.5 8h13 M8 1.5c2.5 2 2.5 11 0 13 M8 1.5C5.5 3.5 5.5 12.5 8 14.5",
  warning: "M8 2l6 11H2z M8 6.5V9 M8 11v.01",
  alert: "M8 2l6 11H2z M8 6.5V9 M8 11v.01",
  threat: "M8 2l6 11H2z M6 8l4 4 M10 8l-4 4",
  check: "M3 8.5l3.5 3.5L13 5",
  info: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M8 7v4.5 M8 4.5v.01",
  // hardware / device tags
  chip: "M5.5 5.5h5v5h-5z M8 3v2.5 M8 10.5V13 M3 8h2.5 M10.5 8H13",
  keyboard:
    "M1.5 4.5h13v7h-13z M3 8h.01 M5.5 8h.01 M8 8h.01 M10.5 8h.01 M5 6.5h.01 M8 6.5h.01 M3.5 10.5h9",
  camera:
    "M1.5 4.5h4l1.5-2h4L12.5 4.5h2v8h-13z M8 8.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  audio:
    "M2.5 6h2l3-3v10l-3-3h-2z M11 6a3 3 0 0 1 0 4 M12.8 4a5.5 5.5 0 0 1 0 8",
  headset: "M4 10.5v-3a4 4 0 0 1 8 0v3 M2.5 10.5h1.5v4H2.5z M12 10.5h1.5v4H12z",
  bluetooth: "M5 3l6 5.5-6 4.5V3z M5 3v10 M11 8l5-3.5 M11 8l5 3.5",
  wifi:
    "M8 12.5a.75.75 0 1 0 0 .01 M2.5 6a8.5 8.5 0 0 1 11 0 M4.8 8.5a5.5 5.5 0 0 1 6.4 0 M7 11a2 2 0 0 1 2 0",
  storage: "M1.5 3.5h13v9h-13z M1.5 6h13 M4 5h.01 M7 5h.01",
  drive: "M1.5 3.5h13v9h-13z M1.5 6h13 M4 8.5h.01 M7 8.5h.01 M10 8.5h.01",
  port: "M1.5 4h13v3H1.5z M4 5.5h.01 M1.5 12h13",
  folder: "M1.5 3.5h5l2 2h6v7h-13z",
  refresh: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9 M13.5 2.5V5.5H10.5",
  copy: "M5.5 2.5h8v8h-8z M2.5 5.5h3v8h8",
  sun:
    "M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M8 1v1.5 M8 13.5V15 M1.5 8H3 M13 8h1.5 M3 3l1 1 M12 12l1 1 M3 13l1-1 M12 4l1-1",
  moon: "M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5 4.5 4.5 0 0 0 13.5 9.5z",
  pause: "M5 2.5v11 M11 2.5v11",
  play: "M5 2.5L12.5 8 5 13.5z",
  kernel:
    "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M8 1.5a6.5 6.5 0 0 1 0 13 M1.5 8h13",
  arch: "M4 3h8l4 5-4 5H4L0 8z M8 4.5l2.5 3.5L8 11.5 5.5 8z",
  gauge: "M3.5 5.5A5 5 0 0 0 13 11 M8 8l3-3.5",
  cog:
    "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M6.5 1.5h3l.6 2 1.9.9 2-1 1.5 2.6-1.5 1.4v1.8l1.5 1.4-1.5 2.6-2-1-1.9.9-.6 2h-3l-.6-2-1.9-.9-2 1-1.5-2.6 1.5-1.4V6.4L2.5 5l1.5-2.6 2 1 1.9-.9z",
  procs: "M4 2.5h8v3H4z M4 10.5h8v3H4z M4 6.5h8v3H4z",
  os: "M2 3.5h12v9H2z M6 2.5v2 M10 2.5v2 M2 8h12",
  link: "M6.5 9.5L9.5 6.5 M4 12l-2-2a3 3 0 0 1 4-4.5 M12 4l2 2a3 3 0 0 1-4 4.5",
  server:
    "M1.5 3.5h13v4H1.5z M1.5 10.5h13v4H1.5z M4 5.5h.01 M7 5.5h.01 M4 12.5h.01 M7 12.5h.01",
  eye:
    "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  key:
    "M13.5 6.5a3 3 0 0 1-4.2 2.8L6 12.5H3.5V10l3.2-3.3A3 3 0 1 1 13.5 6.5z M11 4.5v.01",
};

const Icon = ({ name, size = 14 }: { name: string; size?: number }) => (
  <svg
    class="panel-icon"
    width={size}
    height={size}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path
      d={ICON_PATHS[name] ?? ICON_PATHS.check}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
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
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-dasharray={`${p.toFixed(1)} ${(100 - p).toFixed(1)}`}
          stroke-dashoffset="25"
          style={{ stroke: color, color }}
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
        stroke-width="4"
        stroke-linecap="round"
        stroke-dasharray={`${p.toFixed(1)} ${(100 - p).toFixed(1)}`}
        stroke-dashoffset="25"
        style={{ stroke: color, color }}
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
  { data, color = C.accent }: { data: number[]; color?: string },
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
          <stop
            {...{ offset: "0%", stopOpacity: "0.34" }}
            style={{ stopColor: color }}
          />
          <stop
            {...{ offset: "100%", stopOpacity: "0" }}
            style={{ stopColor: color }}
          />
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
        stroke-width="1.6"
        vector-effect="non-scaling-stroke"
        style={{ stroke: color }}
      />
      <circle
        class="spark-dot"
        cx={lx.toFixed(1)}
        cy={ly.toFixed(1)}
        r="2"
        style={{ fill: color }}
      />
    </svg>
  );
};

// ── presentational primitives ───────────────────────────────────────────────

const Metric = (
  { label, value, sub, color, icon }: {
    label: string;
    value: string;
    sub?: string;
    color?: string;
    icon?: string;
  },
) => (
  <div class="metric">
    <div class="metric-label">
      {icon && <Icon name={icon} size={10} />}
      {label}
    </div>
    <div class="metric-value" style={color ? { color } : undefined}>
      {value}
    </div>
    {sub && <div class="metric-sub">{sub}</div>}
  </div>
);

// Clipboard write from a click handler (browser-side, navigator.clipboard).
// Brief `ok` class on success; on failure warns at the site and flashes
// `copy-failed` (red ✗) — never a silent no-op.
const copyText = (e: Event, text: string, ok: string) => {
  const btn = e.currentTarget as HTMLElement;
  const flash = (cls: string) => {
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 1200);
  };
  const clip = globalThis.navigator?.clipboard;
  (clip ? clip.writeText(text) : Promise.reject(new Error("no clipboard API")))
    .then(() => flash(ok), (err) => {
      console.warn("[machine] copy to clipboard failed:", err);
      flash("copy-failed");
    });
};

// Copy-to-clipboard button — writes a human-friendly report block (built per
// section) to the clipboard.
const CopyButton = ({ text, label }: { text: string; label: string }) => (
  <button
    class="copy-btn"
    type="button"
    aria-label={`Copy ${label}`}
    title="copy this section as text"
    onClick={(e: Event) => copyText(e, text, "copied")}
  >
    <span class="copy-ic">
      <Icon name="copy" size={11} />
    </span>
    <span class="copy-ok">
      <Icon name="check" size={11} />
    </span>
    <span class="copy-err">✗</span>
  </button>
);

const Panel = (
  { title, accent, icon, right, copy, children }: {
    title: string;
    accent: string;
    icon?: string;
    right?: unknown;
    copy?: string;
    children: unknown;
  },
) => (
  // --accent drives accent-aware CSS (title icon, badge)
  <div class="panel" style={{ "--accent": accent }}>
    <div class="panel-head">
      <div class="panel-title">
        {icon && <Icon name={icon} />}
        {title}
      </div>
      {(right != null || copy != null) && (
        <div class="panel-right">
          {right}
          {copy != null && <CopyButton text={copy} label={title} />}
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
  <span class="badge" style={{ color, borderColor: tint(color) }}>
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
const Chip = ({ icon, label, value, color }: {
  icon: string;
  label: string;
  value: string;
  color?: string;
}) => (
  <span class="chip" title={label}>
    <Icon name={icon} size={11} />
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
                <span class="todo-icon">
                  <Icon
                    name={it.sev === "crit"
                      ? "threat"
                      : it.sev === "sec"
                      ? "shield"
                      : it.sev === "warn"
                      ? "warning"
                      : "info"}
                    size={13}
                  />
                </span>
                <span class="todo-text">{it.text}</span>
                <span class="todo-sev" style={{ color: SEV[it.sev].color }}>
                  {SEV[it.sev].tag}
                </span>
              </div>
            ))}
          </div>
        )
        : (
          <div class="todo-ok">
            <Icon name="check" size={13} /> All systems optimal
          </div>
        )}
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
    accent={C.accent}
    icon="cpu"
    copy={cpuReport(info, sys)}
    right={info
      ? <Badge text={`${info.cores} thr`} color={C.accent} />
      : undefined}
  >
    {info
      ? (
        <>
          <div class="model">{info.model || "—"}</div>
          <div class="cpu-hero">
            <div class="cpu-gauge">
              <Ring
                value={info.util_pct}
                color={coreColor(info.util_pct)}
                label="util"
                size={88}
              />
              <div class="cpu-stats">
                <Metric
                  label="temp"
                  icon="temp"
                  value={temp(info.temp_c)}
                  color={tempColor(info.temp_c)}
                />
                <Metric
                  label="freq"
                  icon="bolt"
                  value={fmtMhz(sys?.cpu_mhz ?? 0)}
                  sub={sys?.cpu_max_mhz
                    ? `↑ ${fmtMhz(sys.cpu_max_mhz)}`
                    : undefined}
                  color={C.cyan}
                />
                <Metric
                  label="load"
                  icon="load"
                  value={sys ? sys.load1.toFixed(2) : "—"}
                  sub={sys
                    ? `${sys.load5.toFixed(2)}·${sys.load15.toFixed(2)}`
                    : undefined}
                />
              </div>
            </div>
            <div class="cpu-chart">
              <div class="cpu-chart-head">
                <span class="chart-title">history</span>
                <span
                  class="chart-live"
                  style={{ color: coreColor(info.util_pct) }}
                >
                  {pct(info.util_pct)}
                </span>
              </div>
              <div class="chart-box">
                <Sparkline data={history} color={coreColor(info.util_pct)} />
              </div>
            </div>
          </div>
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
                  <i style={{ background: C.lime }} />50
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
      accent={C.accent}
      icon="mem"
      copy={memReport(info, dimms, sys)}
    >
      {info
        ? (
          <>
            <div class="metric-row">
              <Metric
                label="used"
                icon="ram"
                value={fmtKb(info.used_kb)}
                color={C.green}
              />
              <Metric label="total" value={fmtKb(info.total_kb)} />
              <Metric
                label="free"
                icon="drive"
                value={fmtKb(info.available_kb)}
                color={C.cyan}
              />
              {info.temp_c > 0 && (
                <Metric
                  label="temp"
                  icon="temp"
                  value={temp(info.temp_c)}
                  color={tempColor(info.temp_c, TEMP.dimm)}
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
                <span class="swap-label">
                  <Icon name="swap" size={10} /> swap
                </span>
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
    accent={C.accent}
    icon="board"
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
            color={slotsTotal === 0
              ? undefined
              : dimmCount >= slotsTotal
              ? C.warn
              : C.green}
          />
          {/* kata: every metric panel has a graphical element */}
          {slotsTotal > 0 && (
            <SegBar
              value={dimmCount}
              max={slotsTotal}
              segs={slotsTotal}
              color={C.accent}
            />
          )}
          {slotsTotal === 0 && info.temps_c.length > 0 && (
            <Bar
              value={Math.max(...info.temps_c)}
              max={100}
              color={tempColor(Math.max(...info.temps_c))}
            />
          )}
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
    accent={C.accent}
    icon="gpu"
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
                  icon="temp"
                  value={temp(g.temp_c)}
                  color={tempColor(g.temp_c, TEMP.gpu)}
                />
                <Metric
                  label="vram"
                  icon="vram"
                  value={g.mem_total_mb
                    ? `${(g.mem_used_mb / 1024).toFixed(1)}/${
                      (g.mem_total_mb / 1024).toFixed(1)
                    } GiB`
                    : "—"}
                  color={vramPct > 85 ? C.bad : C.accent}
                />
              </div>
            </div>
            {g.mem_total_mb > 0 && (
              <>
                <SegBar value={vramPct} max={100} color={C.accent} />
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
    accent={C.accent}
    icon="disk"
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
                {fmtBytes(info.root_avail_b)} free on /
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

// Group listening sockets for display — one pill per (process, exposure)
// instead of one per port: a dev box can hold 70+ listeners (test validators,
// game clients) and per-port pills flood the panel. Pure + exported for tests.
export type PortGroup = {
  label: string; // "sshd:22" (single) or "solana-test-val ×22" (many)
  detail: string; // full port list for the tooltip
  exposed: boolean;
  count: number;
};
export const groupPorts = (ports: SecInfo["ports"]): PortGroup[] => {
  const by = new Map<
    string,
    { name: string; ports: typeof ports; exposed: boolean }
  >();
  for (const p of ports) {
    const name = p.process || p.proto;
    const key = `${name}·${p.exposed ? 1 : 0}`;
    const g = by.get(key) ?? { name, ports: [], exposed: p.exposed };
    g.ports.push(p);
    by.set(key, g);
  }
  return [...by.values()]
    .map((g) => {
      return {
        label: g.ports.length === 1
          ? `${g.name}:${g.ports[0]?.port}`
          : `${g.name} ×${g.ports.length}`,
        detail: g.ports.map((p) => `${p.proto} ${p.addr}:${p.port}`).join("\n"),
        exposed: g.exposed,
        count: g.ports.length,
      };
    })
    // exposed first, then biggest groups — the risky stuff reads first
    .sort((a, b) => Number(b.exposed) - Number(a.exposed) || b.count - a.count);
};

// Security panel — posture score ring, hardening checklist, listening ports,
// suspicious processes. Everything judged in the Rust parser; this renders.
const SecPanel = (
  { sec, net }: { sec: SecInfo | null; net: NetInfo | null },
) => {
  const score = secScore(sec, net);
  const scoreColor = score >= 80 ? C.green : score >= 55 ? C.warn : C.bad;
  const exposed = sec ? sec.ports.filter((p) => p.exposed) : [];
  const passed = sec ? sec.checks.filter((c) => c.ok).length : 0;
  return (
    <Panel
      title="SECURITY"
      accent={C.accent}
      icon="sec"
      copy={secReport(sec, net)}
      right={sec
        ? (
          <Badge
            text={sec.procs.length > 0 ? "THREAT" : `${score}`}
            color={sec.procs.length > 0 ? C.bad : scoreColor}
            dot={sec.procs.length > 0}
          />
        )
        : undefined}
    >
      {sec
        ? (
          <>
            <div class="sec-top">
              <Ring value={score} color={scoreColor} label="score" size={62} />
              <div class="sec-stats">
                <Metric
                  label="checks"
                  icon="shield"
                  value={`${passed}/${sec.checks.length}`}
                  color={passed === sec.checks.length ? C.green : C.warn}
                />
                <Metric
                  label="exposed"
                  icon="globe"
                  value={String(exposed.length)}
                  sub={`${sec.ports.length} listening`}
                  color={exposed.length === 0 ? C.green : C.warn}
                />
                <Metric
                  label="threats"
                  icon="threat"
                  value={String(sec.procs.length)}
                  color={sec.procs.length === 0 ? C.green : C.bad}
                />
              </div>
            </div>
            {sec.procs.length > 0 && (
              <div class="sec-threats">
                {sec.procs.map((p, i) => (
                  <div class="sec-threat" key={i} title={p.cmd}>
                    <span class="sec-mark" style={{ color: C.bad }}>
                      <Icon name="threat" size={12} />
                    </span>
                    <span class="sec-check-label">
                      {p.pid} {p.user} · {p.reason}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {sec.checks.length > 0 && (
              <div class="sec-checks">
                {sec.checks.map((c, i) => (
                  <div class="sec-check" key={i} title={c.hint}>
                    <span
                      class="sec-mark"
                      style={{ color: c.ok ? C.green : C.bad }}
                    >
                      <Icon name={c.ok ? "check" : "alert"} size={12} />
                    </span>
                    <span class="sec-check-label">{c.label}</span>
                    <span
                      class="sec-check-val"
                      style={{ color: c.ok ? C.dim : C.warn }}
                    >
                      {c.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {sec.ports.length > 0 && (
              <div class="sec-ports" title="listening sockets (ss -tuln)">
                {groupPorts(sec.ports).map((g, i) => (
                  <span
                    class="sec-port"
                    key={i}
                    style={{
                      color: g.exposed ? C.warn : C.dim,
                      borderColor: tint(g.exposed ? C.warn : C.dim),
                    }}
                    title={`${g.detail}\n${
                      g.exposed ? "reachable from the network" : "loopback only"
                    }`}
                  >
                    <Icon name={g.exposed ? "globe" : "lock"} size={11} />{" "}
                    {g.label}
                  </span>
                ))}
              </div>
            )}
          </>
        )
        : <div class="empty">no security data</div>}
    </Panel>
  );
};

// Rate bar ceiling: the link speed when known; Wi-Fi/VPN report none (≤0),
// so scale to the current peak with a 100 Mbps floor.
const netCap = (sp: NetInfo["speed"]): number =>
  sp.link_max_mbps > 0
    ? sp.link_max_mbps
    : Math.max(sp.rx_mbps, sp.tx_mbps, 100);
const netUnit = (sp: NetInfo["speed"]): string =>
  sp.link_max_mbps > 0 ? `/${sp.link_max_mbps} Mbps` : " Mbps";

const NetPanel = ({ info }: { info: NetInfo | null }) => (
  <Panel
    title="NETWORK"
    accent={C.accent}
    icon="net"
    copy={netReport(info)}
  >
    {info
      ? (
        <>
          <div class="metric-row">
            <Metric
              label="vpn"
              icon={info.vpn ? "lock" : "unlock"}
              value={info.vpn ? "UP" : "down"}
              color={info.vpn ? C.green : C.dim}
            />
            <Metric
              label="firewall"
              icon="shield"
              value={info.firewall.backend}
              sub={info.firewall.active ? "active" : "inactive"}
              color={info.firewall.active ? C.green : C.warn}
            />
          </div>
          {info.speed && (
            <div class="net-speed">
              <div class="net-speed-row">
                <span class="net-label">↓ rx</span>
                <Bar
                  value={info.speed.rx_mbps}
                  max={netCap(info.speed)}
                  color={C.green}
                />
                <span class="net-val">
                  {info.speed.rx_mbps.toFixed(1)}
                  <i>{netUnit(info.speed)}</i>
                </span>
              </div>
              <div class="net-speed-row">
                <span class="net-label">↑ tx</span>
                <Bar
                  value={info.speed.tx_mbps}
                  max={netCap(info.speed)}
                  color={C.cyan}
                />
                <span class="net-val">
                  {info.speed.tx_mbps.toFixed(1)}
                  <i>{netUnit(info.speed)}</i>
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
  items,
  render,
  copy,
}: {
  title: string;
  accent: string;
  icon?: string;
  items: T[];
  render: (item: T, i: number) => unknown;
  copy?: string;
}) => (
  <Panel
    title={title}
    accent={accent}
    icon={icon}
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
        <stop {...{ offset: "0%" }} style={{ stopColor: C.accent }} />
        <stop {...{ offset: "50%" }} style={{ stopColor: C.green }} />
        <stop {...{ offset: "100%" }} style={{ stopColor: C.cyan }} />
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

// Left-bar tabs, in card order. Icon keys are the cards' own header icons.
const TABS: { id: View; icon: string; label: string }[] = [
  { id: "all", icon: "all", label: "All" },
  { id: "todo", icon: "todo", label: "Todo" },
  { id: "cpu", icon: "cpu", label: "CPU" },
  { id: "mem", icon: "mem", label: "Mem" },
  { id: "board", icon: "board", label: "Board" },
  { id: "gpu", icon: "gpu", label: "GPU" },
  { id: "disk", icon: "disk", label: "Disk" },
  { id: "sec", icon: "sec", label: "Sec" },
  { id: "net", icon: "net", label: "Net" },
  { id: "pci", icon: "pci", label: "PCI" },
  { id: "usb", icon: "usb", label: "USB" },
];

export default function App() {
  const s = machine;
  // nothing re-renders while paused, so a ticking age would freeze — say so
  const age = s.paused ? "paused" : ago(s.lastRefresh);
  const refreshing = s.refreshing;
  const paused = s.paused;
  const sys = s.sys;
  const theme = s.theme;

  const cpuUtil = s.cpu?.util_pct ?? 0;
  const memUtil = s.mem?.used_pct ?? 0;
  const gpuUtil = s.gpu?.gpus[0]?.util_pct ?? 0;
  const cpuTemp = s.cpu?.temp_c ?? 0;
  const issues = computeHealth(s);

  const view = s.view;
  // every card, tagged with its tab id; "all" shows them all, a tab just one
  const cards: [View, unknown][] = [
    [
      "todo",
      <TodoPanel key="todo" issues={issues} />,
    ],
    [
      "cpu",
      <CpuPanel key="cpu" info={s.cpu} history={s.cpuUtilHistory} sys={sys} />,
    ],
    [
      "mem",
      <MemPanel key="mem" info={s.mem} dimms={s.dimms} sys={sys} />,
    ],
    [
      "board",
      <BoardPanel
        key="board"
        info={s.board}
        dimmCount={s.dimms.length}
        slotsTotal={s.memSlotsTotal}
      />,
    ],
    [
      "gpu",
      <GpuPanel key="gpu" info={s.gpu} />,
    ],
    [
      "disk",
      <DiskPanel key="disk" info={s.disk} />,
    ],
    [
      "sec",
      <SecPanel key="sec" sec={s.sec} net={s.net} />,
    ],
    [
      "net",
      <NetPanel key="net" info={s.net} />,
    ],
    [
      "pci",
      <ListPanel
        key="pci"
        title="LSPCI"
        accent={C.accent}
        icon="pci"
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
              <span class="dev-emoji">
                <Icon name={pciIcon(e.class)} size={12} />
              </span>
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
      />,
    ],
    [
      "usb",
      <ListPanel
        key="usb"
        title="LSUSB"
        accent={C.accent}
        icon="usb"
        items={s.lsusb}
        copy={lsusbReport(s.lsusb)}
        render={(e) => (
          <>
            <span class="dev-emoji">
              <Icon name={usbIcon(e.name)} size={12} />
            </span>
            <span class="dev-name" title={e.name}>{cleanHw(e.name)}</span>
            <span class="dev-tag mono">{e.id}</span>
          </>
        )}
      />,
    ],
  ];

  return (
    <div class="app" data-theme={theme}>
      <header class="header">
        <div class="brand">
          <BrandMark />
          <div class="brand-text">
            <span class="brand-name">machine</span>
            <span class="brand-sub">
              {sys?.hostname ? <Icon name="server" size={9} /> : ""}
              {sys?.hostname ? ` ${sys.hostname}` : "hardware deck"}
            </span>
          </div>
        </div>

        <div class="vitals">
          <Chip
            icon="cpu"
            label="cpu"
            value={pct(cpuUtil)}
            color={coreColor(cpuUtil)}
          />
          <Chip
            icon="mem"
            label="mem"
            value={pct(memUtil)}
            color={coreColor(memUtil)}
          />
          {s.gpu && s.gpu.gpus.length > 0 && (
            <Chip
              icon="gpu"
              label="gpu"
              value={pct(gpuUtil)}
              color={coreColor(gpuUtil)}
            />
          )}
          <Chip
            icon="temp"
            label="temp"
            value={temp(cpuTemp)}
            color={tempColor(cpuTemp)}
          />
        </div>

        <div class="status">
          {s.wasmAvailable
            ? <Badge text="wasm" color={C.green} dot />
            : <Badge text="wasm off" color={C.warn} dot />}
          <span class="age" title="last refresh">
            <Icon name="clock" size={11} /> {age}
          </span>
          <button
            class="ctrl"
            type="button"
            aria-label="CopyAll"
            title="copy full system report"
            onClick={(e: Event) =>
              copyText(e, fullReport(s, issues), "copied-flash")}
          >
            <Icon name="copy" size={14} />
          </button>
          <button
            class="ctrl"
            type="button"
            aria-label="Theme"
            title={theme === "dark" ? "switch to light" : "switch to dark"}
            onClick={() => machine.toggleTheme()}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
          </button>
          <button
            class={paused ? "ctrl ctrl-on" : "ctrl"}
            type="button"
            aria-label="Pause"
            title={paused ? "resume auto-refresh" : "pause auto-refresh"}
            onClick={() => machine.togglePause()}
          >
            <Icon name={paused ? "play" : "pause"} size={14} />
          </button>
          <button
            class={refreshing ? "refresh busy" : "refresh"}
            type="button"
            aria-label="Refresh"
            title="refresh now"
            onClick={() => machine.refresh(true)}
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </header>

      {sys && (
        <div class="sysbar">
          <Chip icon="kernel" label="kernel" value={sys.kernel || "—"} />
          <Chip icon="arch" label="arch" value={sys.arch || "—"} />
          <Chip
            icon="clock"
            label="uptime"
            value={fmtUptime(sys.uptime_s)}
            color={C.green}
          />
          <Chip
            icon="pulse"
            label="load"
            value={`${sys.load1.toFixed(2)} · ${sys.load5.toFixed(2)} · ${
              sys.load15.toFixed(2)
            }`}
          />
          {sys.procs_total > 0 && (
            <Chip
              icon="procs"
              label="procs"
              value={`${sys.procs_running}/${sys.procs_total}`}
            />
          )}
          {sys.governor && (
            <Chip icon="cog" label="governor" value={sys.governor} />
          )}
        </div>
      )}

      <div class="body">
        <nav class="tabs" aria-label="cards">
          {TABS.map((t) => (
            <button
              key={t.id}
              class={t.id === view ? "tab tab-on" : "tab"}
              type="button"
              aria-label={`${t.label}Tab`}
              aria-pressed={t.id === view}
              title={t.id === "all" ? "show all cards" : `show only ${t.label}`}
              onClick={() => machine.setView(t.id)}
            >
              <Icon name={t.icon} size={15} />
              <span class="tab-label">{t.label}</span>
              {t.id === "todo" && issues.length > 0 && <span class="tab-dot" />}
            </button>
          ))}
        </nav>
        <main class="grid">
          {view === "all"
            ? <div class="cards">{cards.map(([, card]) => card)}</div>
            : (
              <div class="cards single">
                {cards.find(([id]) => id === view)?.[1]}
              </div>
            )}
        </main>
      </div>
    </div>
  );
}
