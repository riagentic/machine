// src/io.server.ts — server-only I/O + WASM loader. NEVER imported by App.tsx
// or any browser-reachable module. The cell (src/wasm.ts) dynamic-imports this
// inside its async `refresh` method, so the browser bundle never sees Deno.*
// (aio marks `*.server.ts` dynamic imports as external — see docs/build/imports.md).
//
// Loading is lazy (first await) and cached. If the WASM module is missing
// (e.g. `deno task wasm` not run) every call resolves to null — the app never
// throws; the UI shows degraded state with a visible "wasm off" badge.

import type {
  BoardInfo,
  CpuInfo,
  DimmInfo,
  DiskInfo,
  GpuInfo,
  LspciEntry,
  LsusbEntry,
  MemInfo,
  NetInfo,
  SecInfo,
  SysInfo,
} from "./wasm.ts";

export type {
  BoardInfo,
  CpuInfo,
  DimmInfo,
  DiskInfo,
  GpuInfo,
  LspciEntry,
  LsusbEntry,
  MemInfo,
  NetInfo,
  SecInfo,
  SysInfo,
};

type WasmExports = {
  memory: WebAssembly.Memory;
  alloc: (len: number) => number;
  dealloc: (ptr: number, len: number) => void;
  str_len: (ptr: number) => number;
  free_str: (ptr: number) => void;
  sys_cpu: (
    cpuinfo: number,
    cpuinfo_len: number,
    stat: number,
    stat_len: number,
    hwmon: number,
    hwmon_len: number,
  ) => number;
  sys_mem: (meminfo: number, len: number) => number;
  sys_board: (
    bn: number,
    bnl: number,
    bv: number,
    bvl: number,
    bver: number,
    bverl: number,
    bven: number,
    bvenl: number,
    bbver: number,
    bbverl: number,
    bd: number,
    bdl: number,
    pn: number,
    pnl: number,
    hw: number,
    hwl: number,
  ) => number;
  sys_gpu: (nv: number, nvl: number, hw: number, hwl: number) => number;
  sys_disk: (df: number, len: number) => number;
  sys_lspci: (raw: number, len: number) => number;
  sys_lsusb: (raw: number, len: number) => number;
  sys_net: (
    aj: number,
    ajl: number,
    lj: number,
    ljl: number,
    r: number,
    rl: number,
    fw: number,
    fwl: number,
    si: number,
    sil: number,
  ) => number;
  sys_dimms: (raw: number, len: number) => number;
  sys_sec: (
    ss: number,
    ssl: number,
    ps: number,
    psl: number,
    sysctl: number,
    syl: number,
    sshd: number,
    shl: number,
    facts: number,
    fal: number,
  ) => number;
};

let _exports: WasmExports | null = null;
let _loadPromise: Promise<WasmExports | null> | null = null;
let _warnedMissing = false;

function load(): Promise<WasmExports | null> {
  if (_exports) return Promise.resolve(_exports);
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const url = new URL("./syscalls.wasm", import.meta.url);
      const bytes = await Deno.readFile(url);
      const mod = await WebAssembly.compile(bytes);
      const inst = await WebAssembly.instantiate(mod, {
        env: { vmlog: (_p: number, _l: number) => {} },
      });
      _exports = inst.exports as unknown as WasmExports;
      return _exports;
    } catch (e) {
      if (!_warnedMissing) {
        _warnedMissing = true;
        console.warn(
          `[machine] syscalls.wasm not available — run \`deno task wasm\` to build it. ` +
            `Hardware panels will show degraded state. (${
              String(e).split("\n")[0]
            })`,
        );
      }
      return null;
    }
  })();
  return _loadPromise;
}

// ── marshalling helpers ────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function writeInput(
  e: WasmExports,
  input: string,
): { ptr: number; len: number } {
  const buf = enc.encode(input);
  const ptr = e.alloc(buf.length);
  new Uint8Array(e.memory.buffer, ptr, buf.length).set(buf);
  return { ptr, len: buf.length };
}

function readOutput(e: WasmExports, ptr: number): string {
  const len = e.str_len(ptr);
  const view = new Uint8Array(e.memory.buffer, ptr, len);
  const s = dec.decode(view);
  e.free_str(ptr);
  return s;
}

/** Call a WASM syscall with string inputs; returns the parsed JSON. */
async function call<T>(
  fn: keyof WasmExports,
  inputs: string[],
): Promise<T | null> {
  const e = await load();
  if (!e) return null;
  // allocate all inputs first (alloc may grow memory, invalidating earlier views)
  const args = inputs.map((s) => writeInput(e, s));
  const fnRef = e[fn] as (...args: number[]) => number;
  const outPtr = fnRef(...args.flatMap((a) => [a.ptr, a.len]));
  const out = readOutput(e, outPtr);
  // free inputs
  args.forEach((a) => e.dealloc(a.ptr, a.len));
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

// ── host I/O: async reads + commands, all off the dispatch loop ────────────
// Every I/O helper is async so the cell's `refresh` method never blocks the
// reduce/dispatch loop. The kata requires the app never freeze the underlying
// PC/OS; sync file reads and `outputSync()` would run on the dispatch thread.

// Platform detection — Linux is primary; Windows and OSX are supported via
// command fallbacks. The Rust parsers are generic (parse text → JSON); we
// feed them the right text per OS.
const PLATFORM: "linux" | "windows" | "darwin" = Deno.build.os === "windows"
  ? "windows"
  : Deno.build.os === "darwin"
  ? "darwin"
  : "linux";

export { PLATFORM };

async function readFile(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

async function runCmd(
  cmd: readonly string[],
  opts?: { env?: Record<string, string> },
): Promise<string> {
  const bin = cmd[0];
  if (!bin) return "";
  try {
    const p = new Deno.Command(bin, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "null",
      env: opts?.env,
    });
    const out = await p.output();
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return "";
  }
}

// gather hwmon into a textual block: "name\ntempN_input\n..." per device
async function readHwmonBlock(
  filter: (name: string) => boolean,
): Promise<string> {
  let out = "";
  try {
    for await (const e of Deno.readDir("/sys/class/hwmon")) {
      // /sys/class/hwmon/hwmonN entries are SYMLINKS to the device dir, so
      // isDirectory is false — accept symlinks too, or every temp reads empty.
      if (!e.isDirectory && !e.isSymlink) continue;
      const dir = `/sys/class/hwmon/${e.name}`;
      const name = (await readFile(`${dir}/name`)).trim();
      if (!filter(name)) continue;
      out += name + "\n";
      for (let i = 1; i <= 8; i++) {
        const v = (await readFile(`${dir}/temp${i}_input`)).trim();
        if (!v) break;
        out += v + "\n";
      }
    }
  } catch {
    // /sys/class/hwmon not readable
  }
  return out;
}

// ── public syscall API (pure async, never throws) ─────────────────────────
// Each reads inputs async (off the dispatch loop) then hands the bytes to the
// WASM parser via `call`. Never throws: a missing wasm or a failed parse
// resolves to null, so the UI shows degraded state instead of crashing.
// Platform-aware: Linux reads /sys + /proc + lspci/lsusb/ip; Windows uses
// wmic/Get-* PowerShell; OSX uses system_profiler/ioreg/networksetup.

export async function cpu(): Promise<CpuInfo | null> {
  if (PLATFORM !== "linux") return cpuNonLinux();
  const cpuinfo = await readFile("/proc/cpuinfo");
  // Full /proc/stat — the Rust parser extracts the aggregate line + per-core
  // cpuN lines so the cell can compute both aggregate + per-core utilization.
  const stat = await readFile("/proc/stat");
  const hwmon = await readHwmonBlock((n) =>
    n.includes("coretemp") || n.includes("k10temp") ||
    n.includes("cpu_thermal") || n.includes("zenpower") || n === "core"
  );
  return call<CpuInfo>("sys_cpu", [cpuinfo, stat, hwmon]);
}

// Windows/OSX: synthesize a cpuinfo-like text + a stat line the Rust parser
// can read. util_pct is derived from a single sample on these platforms
// (PowerShell Get-Counter / top -l 1) and stamped onto the parsed CpuInfo.
async function cpuNonLinux(): Promise<CpuInfo | null> {
  if (PLATFORM === "windows") {
    const name = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Processor).Name",
    ]);
    const coresStr = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Processor).NumberOfLogicalProcessors",
    ]);
    const temp = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_TemperatureProbe | Select-Object -ExpandProperty CurrentReading",
    ]);
    const util = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue",
    ]);
    // synthesize cpuinfo: one "processor" line per logical core so the Rust
    // parser (which counts "processor" occurrences) reports the right number.
    const nCores = Math.max(1, parseInt(coresStr) || 1);
    const procLines = Array.from(
      { length: nCores },
      (_, i) => `processor       : ${i}`,
    ).join("\n");
    const cpuinfo = `model name      : ${name}\n${procLines}\n`;
    const stat = `cpu ${util || "0"}`;
    const r = await call<CpuInfo>("sys_cpu", [cpuinfo, stat, temp || ""]);
    if (r) r.util_pct = Math.max(0, Math.min(100, parseFloat(util) || 0));
    return r;
  }
  // darwin
  const name = await runCmd(["sysctl", "-n", "machdep.cpu.brand_string"]);
  const coresStr = await runCmd(["sysctl", "-n", "hw.logicalcpu"]);
  const util = await runCmd([
    "sh",
    "-c",
    "top -l 1 -n 0 | grep 'CPU usage' | head -1",
  ]);
  // "CPU usage: 12.5% user, 5.2% sys, 82.3% idle" → extract idle → util = 100-idle
  const idleMatch = util.match(/([\d.]+)%\s*idle/);
  const utilPct = idleMatch ? (100 - parseFloat(idleMatch[1] ?? "0")) : 0;
  const nCores = Math.max(1, parseInt(coresStr) || 1);
  const procLines = Array.from(
    { length: nCores },
    (_, i) => `processor       : ${i}`,
  ).join("\n");
  const cpuinfo = `model name      : ${name}\n${procLines}\n`;
  const stat = `cpu ${utilPct}`;
  const r = await call<CpuInfo>("sys_cpu", [cpuinfo, stat, ""]);
  if (r) r.util_pct = Math.max(0, Math.min(100, utilPct));
  return r;
}

export async function mem(): Promise<MemInfo | null> {
  if (PLATFORM !== "linux") return memNonLinux();
  const info = await readFile("/proc/meminfo");
  const r = await call<MemInfo>("sys_mem", [info]);
  // Memory temperature (kata: "if possible"): DDR5 exposes per-module temps via
  // spd5118; older DDR4 via jc42. Host-stamped (Rust parser has no such input).
  if (r) r.temp_c = await memTempC();
  return r;
}

// Hottest DIMM temperature across module sensors, or 0 when none are present.
async function memTempC(): Promise<number> {
  const block = await readHwmonBlock((n) =>
    n.includes("spd5118") || n.includes("jc42") || n.includes("dimm")
  );
  let max = 0;
  for (const line of block.split("\n")) {
    const v = parseInt(line.trim());
    if (!isNaN(v) && v > 1000) max = Math.max(max, v / 1000); // millidegrees
  }
  return max;
}

// DIMM listing — dmidecode -t memory (needs root on Linux). Gracefully
// degrades to empty list + 0 slots if dmidecode isn't available or permission
// denied. slots_total counts every "Memory Device" block (occupied or not) so
// the UI can show occupied/total.
export async function dimms(): Promise<
  { list: DimmInfo[]; slots_total: number }
> {
  if (PLATFORM !== "linux") return { list: [], slots_total: 0 }; // Win/OSX TODO
  const raw = await runCmd(["dmidecode", "-t", "memory"]);
  if (
    !raw || raw.includes("Permission denied") || raw.includes("requires root")
  ) {
    return { list: [], slots_total: 0 };
  }
  const slots_total = (raw.match(/^Memory Device$/gm) ?? []).length;
  const result = await call<DimmInfo[]>("sys_dimms", [raw]);
  return { list: result ?? [], slots_total };
}

async function memNonLinux(): Promise<MemInfo | null> {
  if (PLATFORM === "windows") {
    const total = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "[math]::Ceiling((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1024)",
    ]);
    const free = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "[math]::Ceiling((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1)",
    ]);
    // synthesize meminfo format the Rust parser reads
    const totalKb = parseInt(total) || 0;
    const freeKb = parseInt(free) || 0;
    const info =
      `MemTotal:       ${totalKb} kB\nMemAvailable:   ${freeKb} kB\n`;
    const r = await call<MemInfo>("sys_mem", [info]);
    if (r) r.temp_c = 0; // no cheap per-module temp on Windows
    return r;
  }
  // darwin — vm_stat returns pages; sysctl hw.memsize for total
  const totalBytes = await runCmd(["sysctl", "-n", "hw.memsize"]);
  const vmstat = await runCmd(["vm_stat"]);
  const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
  const pageSize = parseInt(pageSizeMatch?.[1] ?? "4096");
  const freePagesMatch = vmstat.match(/Pages free:\s+(\d+)/);
  const freeKb = freePagesMatch
    ? Math.floor((parseInt(freePagesMatch[1] ?? "0") || 0 * pageSize) / 1024)
    : 0;
  const totalKb = Math.floor((parseInt(totalBytes) || 0) / 1024);
  const info = `MemTotal:       ${totalKb} kB\nMemAvailable:   ${freeKb} kB\n`;
  const r = await call<MemInfo>("sys_mem", [info]);
  if (r) r.temp_c = 0; // no cheap per-module temp on macOS
  return r;
}

export async function board(): Promise<BoardInfo | null> {
  if (PLATFORM !== "linux") return boardNonLinux();
  const read = async (p: string) => (await readFile(p)).trim();
  const hw = await readHwmonBlock((n) =>
    n.startsWith("nct") || n.includes("acpi") || n === "nvme" ||
    n.includes("board")
  );
  const r = await call<BoardInfo>("sys_board", [
    await read("/sys/class/dmi/id/board_name"),
    await read("/sys/class/dmi/id/board_vendor"),
    await read("/sys/class/dmi/id/board_version"),
    await read("/sys/class/dmi/id/bios_vendor"),
    await read("/sys/class/dmi/id/bios_version"),
    await read("/sys/class/dmi/id/bios_date"),
    await read("/sys/class/dmi/id/product_name"),
    hw,
  ]);
  // usb_ports is host-stamped (the Rust parser has no USB input): sum of
  // maxchild over root hubs = physical ports on the machine.
  if (r) r.usb_ports = await usbPortCount();
  return r;
}

async function usbPortCount(): Promise<number> {
  let n = 0;
  try {
    for await (const e of Deno.readDir("/sys/bus/usb/devices")) {
      if (!/^usb\d+$/.test(e.name)) continue;
      const v = parseInt(
        (await readFile(`/sys/bus/usb/devices/${e.name}/maxchild`)).trim(),
      );
      if (v > 0) n += v;
    }
  } catch {
    // /sys/bus/usb not readable
  }
  return n;
}

async function boardNonLinux(): Promise<BoardInfo | null> {
  if (PLATFORM === "windows") {
    const get = async (cls: string, prop: string) =>
      (await runCmd([
        "powershell",
        "-NoProfile",
        "-Command",
        `(Get-CimInstance ${cls}).${prop}`,
      ])).trim();
    const r = await call<BoardInfo>("sys_board", [
      await get("Win32_BaseBoard", "Product"),
      await get("Win32_BaseBoard", "Manufacturer"),
      await get("Win32_BaseBoard", "Version"),
      await get("Win32_BIOS", "Manufacturer"),
      await get("Win32_BIOS", "SMBIOSBIOSVersion"),
      await get("Win32_BIOS", "ReleaseDate"),
      await get("Win32_ComputerSystem", "Model"),
      "",
    ]);
    if (r) r.usb_ports = 0; // no cheap port count on Windows; UI shows "—"
    return r;
  }
  // darwin — system_profiler SPHardwareDataType gives board + BIOS-ish data
  const hw = (await runCmd(["system_profiler", "SPHardwareDataType"])).trim();
  const line = (re: RegExp) => hw.match(re)?.[1]?.trim() ?? "";
  const r = await call<BoardInfo>("sys_board", [
    line(/Model Identifier:\s*(.+)/),
    line(/Manufacturer:\s*(.+)/),
    "",
    "Apple",
    line(/Boot ROM Version:\s*(.+)/),
    "",
    line(/Model Name:\s*(.+)/),
    "",
  ]);
  if (r) r.usb_ports = 0; // no cheap port count on OSX; UI shows "—"
  return r;
}

export async function gpu(): Promise<GpuInfo | null> {
  // nvidia-smi works cross-platform (Linux/Win/OSX) when present
  const nvidia = await runCmd([
    "nvidia-smi",
    "--query-gpu=name,temperature.gpu,utilization.gpu,memory.total,memory.used",
    "--format=csv,noheader,nounits",
  ]);
  let hw = "";
  if (PLATFORM === "linux") {
    try {
      for await (const e of Deno.readDir("/sys/class/drm")) {
        if (!e.name.startsWith("card")) continue;
        const dev = `/sys/class/drm/${e.name}/device`;
        // amdgpu/i915 expose utilization % here; hwmon freq values are Hz,
        // not a percentage — never usable as util.
        const busy = (await readFile(`${dev}/gpu_busy_percent`)).trim();
        const hwmonDir = `${dev}/hwmon`;
        try {
          for await (const h of Deno.readDir(hwmonDir)) {
            const p = `${hwmonDir}/${h.name}`;
            const name = (await readFile(`${p}/name`)).trim();
            if (!name) continue;
            const tempV = (await readFile(`${p}/temp1_input`)).trim();
            hw += `${name}\n${tempV}\n${busy || "0"}\n0\n`;
          }
        } catch {
          // no hwmon
        }
      }
    } catch {
      // /sys/class/drm not readable
    }
  } else if (PLATFORM === "windows") {
    // Windows: nvidia-smi covers NVIDIA; AMD/Intel via wmic
    const amd = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,CurrentBitsPerPixel | Format-List",
    ]);
    if (amd && !nvidia) {
      for (const line of amd.split("\n")) {
        const m = line.match(/Name\s*:\s*(.+)/);
        if (m) hw += `${(m[1] ?? "").trim()}\n0\n0\n0\n`;
      }
    }
  } else if (PLATFORM === "darwin") {
    // OSX: system_profiler SPDisplaysDataType
    const disp = await runCmd(["system_profiler", "SPDisplaysDataType"]);
    for (const line of disp.split("\n")) {
      const m = line.match(/^\s*Chipset Model:\s*(.+)/);
      if (m) hw += `${(m[1] ?? "").trim()}\n0\n0\n0\n`;
    }
  }
  return call<GpuInfo>("sys_gpu", [nvidia, hw]);
}

export async function disk(): Promise<DiskInfo | null> {
  if (PLATFORM === "linux") {
    const df = await runCmd(["df", "-P", "-B1"]);
    return call<DiskInfo>("sys_disk", [df]);
  }
  if (PLATFORM === "windows") {
    // Windows: Get-Volume returns size/free; synthesize df -P format
    const out = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-Volume | Where-Object DriveLetter | ForEach-Object { $_.DriveLetter + ' ' + $_.Size + ' ' + ($_.Size - $_.SizeRemaining) + ' ' + [math]::Round((($_.Size - $_.SizeRemaining)/$_.Size)*100,1) + '%' + ' ' + $_.DriveLetter + ':' }",
    ]);
    // reformat into df -P columns: Filesystem 1B-blocks Used Available Capacity% MountedOn
    const lines = out.split("\n").filter(Boolean).map((l) => {
      const [letter, size, used, pct] = l.trim().split(/\s+/);
      return `${letter}: ${size} ${used} 0 ${pct} ${letter}:`;
    }).join("\n");
    return call<DiskInfo>("sys_disk", [lines]);
  }
  // darwin — df -g works but in GB blocks; use -k for kB
  const df = await runCmd(["df", "-P", "-k"]);
  // convert kB df to B for consistent units: multiply size/used by 1024
  const lines = df.split("\n").map((l) => {
    const cols = l.split(/\s+/);
    if (cols.length < 6 || cols[1] === "1024-blocks") return l;
    const totalB = (parseInt(cols[1] ?? "0") || 0) * 1024;
    const usedB = (parseInt(cols[2] ?? "0") || 0) * 1024;
    return `${cols[0]} ${totalB} ${usedB} 0 ${cols[4] ?? "0%"} ${
      cols[5] ?? "/"
    }`;
  }).join("\n");
  return call<DiskInfo>("sys_disk", [lines]);
}

export async function lspci(): Promise<LspciEntry[] | null> {
  if (PLATFORM === "linux") {
    const raw = await runCmd(["lspci", "-nnmm"]);
    return call<LspciEntry[]>("sys_lspci", [raw]);
  }
  if (PLATFORM === "windows") {
    // Windows: Get-CimInstance Win32_PnPEntity is the closest; parse names
    const out = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_PnPEntity | Select-Object -ExpandProperty Name",
    ]);
    // synthesize lspci -nnmm format: "Class Vendor Name"
    const lines = out.split("\n").filter(Boolean).map((l) => `PCI ${l.trim()}`)
      .join("\n");
    return call<LspciEntry[]>("sys_lspci", [lines]);
  }
  // darwin — system_profiler SPDisplaysDataType + SPThunderboltDataType
  const out = await runCmd(["system_profiler", "SPPCIDataType"]);
  return call<LspciEntry[]>("sys_lspci", [out]);
}

export async function lsusb(): Promise<LsusbEntry[] | null> {
  if (PLATFORM === "linux") {
    const raw = await runCmd(["lsusb"]);
    return call<LsusbEntry[]>("sys_lsusb", [raw]);
  }
  if (PLATFORM === "windows") {
    const out = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPClass -eq 'USB' } | Select-Object -ExpandProperty Name",
    ]);
    // synthesize lsusb format: "Bus 001 Dev 001: ID 0000:0000 Name"
    const lines = out.split("\n").filter(Boolean).map((l) =>
      `Bus 001 Device 001: ID 0000:0000 ${l.trim()}`
    ).join("\n");
    return call<LsusbEntry[]>("sys_lsusb", [lines]);
  }
  // darwin — system_profiler SPUSBDataType
  const out = await runCmd(["system_profiler", "SPUSBDataType"]);
  // the Rust parser expects lsusb format; extract device names heuristically
  const lines = out.split("\n").map((l) => {
    const m = l.match(/^\s*(.+?):\s*$/);
    return m ? `Bus 001 Device 001: ID 0000:0000 ${m[1]}` : "";
  }).filter(Boolean).join("\n");
  return call<LsusbEntry[]>("sys_lsusb", [lines]);
}

export async function net(): Promise<NetInfo | null> {
  if (PLATFORM === "linux") {
    const addrs = await runCmd(["ip", "-j", "-br", "addr"]);
    const links = await runCmd(["ip", "-j", "-br", "link"]);
    const route = await runCmd(["ip", "route", "show", "default"]);
    const fw = await detectFirewallState();
    const speedInfo = await readNetSpeed();
    return call<NetInfo>("sys_net", [addrs, links, route, fw, speedInfo]);
  }
  if (PLATFORM === "windows") {
    const addrs = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-NetIPAddress | Select-Object InterfaceAlias,IPAddress,AddressFamily | ConvertTo-Json",
    ]);
    const route = await runCmd(["route", "print", "0.0.0.0"]);
    const fwState = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "(Get-NetFirewallProfile | Where-Object Enabled).Count",
    ]);
    const fw = parseInt(fwState) > 0 ? "ufw:active" : "none";
    const vpn = addrs.includes("WAN") || addrs.includes("RAS");
    const links = vpn ? '[{"ifname":"tun0"}]' : "[]";
    const speedInfo = readNetSpeedWindows();
    return call<NetInfo>("sys_net", [addrs, links, route, fw, speedInfo]);
  }
  // darwin
  const addrs = await runCmd(["ifconfig"]);
  const route = await runCmd(["netstat", "-rn", "-f", "inet"]);
  const pf = await runCmd(["pfctl", "-s", "info"]);
  const fw = pf.includes("Status: Enabled") ? "ufw:active" : "none";
  const vpn = /utun|ppp|ipsec/.test(addrs);
  const links = vpn ? '[{"ifname":"tun0"}]' : "[]";
  const speedInfo = readNetSpeedDarwin();
  return call<NetInfo>("sys_net", [addrs, links, route, fw, speedInfo]);
}

// Network speed: read link max (Mbps) from /sys/class/net/IFACE/speed and
// rx/tx byte counters from /sys/class/net/IFACE/statistics. The cell computes
// the rate (Mbps) from the byte delta between samples. We stash the raw byte
// counts in rx_mbps/tx_mbps — the cell converts to rates.
async function readNetSpeed(): Promise<string> {
  // Find the default-route interface (the one actually in use)
  const route = await runCmd(["ip", "route", "show", "default"]);
  const ifaceMatch = route.match(/dev\s+(\S+)/);
  const iface = ifaceMatch?.[1] ?? "eth0";
  const speed = await readFile(`/sys/class/net/${iface}/speed`);
  const rxBytes = await readFile(`/sys/class/net/${iface}/statistics/rx_bytes`);
  const txBytes = await readFile(`/sys/class/net/${iface}/statistics/tx_bytes`);
  const linkMax = parseInt(speed.trim()) || 0;
  const rx = parseInt(rxBytes.trim()) || 0;
  const tx = parseInt(txBytes.trim()) || 0;
  // rx_mbps/tx_mbps carry RAW BYTE COUNTS here — the cell computes the rate
  // from the delta. link_max_mbps is the link speed cap.
  return JSON.stringify({ link_max_mbps: linkMax, rx_mbps: rx, tx_mbps: tx });
}

function readNetSpeedWindows(): string {
  // Windows: Get-NetAdapterStats; approximate with current link speed only
  return JSON.stringify({ link_max_mbps: 0, rx_mbps: 0, tx_mbps: 0 });
}

function readNetSpeedDarwin(): string {
  // OSX: netstat -i gives counters; link speed from networksetup
  return JSON.stringify({ link_max_mbps: 0, rx_mbps: 0, tx_mbps: 0 });
}

// ── sys: host identity + live vitals (uptime, load, freq, swap) ────────────
// Cheap host-side reads (no WASM parser needed): /proc/uptime, /proc/loadavg,
// /proc/cpuinfo MHz, cpufreq max, /proc/meminfo swap. Pure best-effort — every
// field defaults to 0/"" and never throws, so non-Linux and locked-down boxes
// degrade to an empty-but-valid struct (kata: never an error).
export async function sys(): Promise<SysInfo> {
  const base: SysInfo = {
    hostname: "",
    kernel: "",
    arch: Deno.build.arch,
    os: PLATFORM,
    uptime_s: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    procs_running: 0,
    procs_total: 0,
    cpu_mhz: 0,
    cpu_max_mhz: 0,
    swap_total_kb: 0,
    swap_used_kb: 0,
    reboot_required: false,
    governor: "",
  };
  try {
    base.hostname = Deno.hostname();
  } catch { /* no --allow-sys */ }
  try {
    base.kernel = Deno.osRelease();
  } catch { /* ignore */ }
  if (PLATFORM !== "linux") return base;

  // Debian/Ubuntu drop this file when a package (often the kernel) needs a
  // reboot to take effect — a cheap "pending updates" security/health signal.
  for (const p of ["/run/reboot-required", "/var/run/reboot-required"]) {
    try {
      await Deno.stat(p);
      base.reboot_required = true;
      break;
    } catch { /* not present */ }
  }

  const uptime = await readFile("/proc/uptime");
  base.uptime_s = parseFloat(uptime.split(/\s+/)[0] ?? "0") || 0;

  const load = (await readFile("/proc/loadavg")).trim().split(/\s+/);
  base.load1 = parseFloat(load[0] ?? "0") || 0;
  base.load5 = parseFloat(load[1] ?? "0") || 0;
  base.load15 = parseFloat(load[2] ?? "0") || 0;
  const procs = (load[3] ?? "").split("/");
  base.procs_running = parseInt(procs[0] ?? "0") || 0;
  base.procs_total = parseInt(procs[1] ?? "0") || 0;

  const cpuinfo = await readFile("/proc/cpuinfo");
  const mhz = [...cpuinfo.matchAll(/cpu MHz\s*:\s*([\d.]+)/g)].map((m) =>
    parseFloat(m[1] ?? "0")
  );
  if (mhz.length) base.cpu_mhz = mhz.reduce((a, b) => a + b, 0) / mhz.length;
  const maxFreq = await readFile(
    "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq",
  );
  base.cpu_max_mhz = (parseInt(maxFreq.trim()) || 0) / 1000;
  base.governor = (await readFile(
    "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
  )).trim();

  const meminfo = await readFile("/proc/meminfo");
  const swTotal = parseInt(meminfo.match(/SwapTotal:\s*(\d+)/)?.[1] ?? "0") ||
    0;
  const swFree = parseInt(meminfo.match(/SwapFree:\s*(\d+)/)?.[1] ?? "0") || 0;
  base.swap_total_kb = swTotal;
  base.swap_used_kb = Math.max(0, swTotal - swFree);
  return base;
}

async function detectFirewallState(): Promise<string> {
  if (await runCmd(["nft", "list", "ruleset"])) return "nftables";
  const ufw = await runCmd(["ufw", "status"]);
  if (ufw) {
    return ufw.includes("Status: active") ? "ufw:active" : "ufw:inactive";
  }
  if (await runCmd(["firewall-cmd", "--state"])) return "firewalld";
  return "none";
}

// ── sec: security posture inputs (ports, processes, hardening facts) ───────
// The host only GATHERS text here; all judgment lives in the Rust sys_sec
// parser (pure, fixture-tested). Every input is best-effort: an unreadable
// source becomes "" and the parser OMITS the affected check — a locked-down
// box degrades to fewer checks, never to false alarms.

// /proc/sys files feeding the hardening checks — "short-key path" pairs; the
// parser looks the short keys up in the "key value" block we assemble.
const SYSCTL_CHECKS: readonly [string, string][] = [
  ["randomize_va_space", "/proc/sys/kernel/randomize_va_space"],
  ["ptrace_scope", "/proc/sys/kernel/yama/ptrace_scope"],
  ["kptr_restrict", "/proc/sys/kernel/kptr_restrict"],
  ["dmesg_restrict", "/proc/sys/kernel/dmesg_restrict"],
  ["ip_forward", "/proc/sys/net/ipv4/ip_forward"],
  ["unprivileged_bpf_disabled", "/proc/sys/kernel/unprivileged_bpf_disabled"],
];

async function secFactsLinux(): Promise<string> {
  const facts: string[] = [];
  // Secure Boot — mokutil is the portable answer; efivars fallback needs root.
  const mok = await runCmd(["mokutil", "--sb-state"]);
  facts.push(
    `secureboot ${
      mok.includes("enabled")
        ? "enabled"
        : mok.includes("disabled")
        ? "disabled"
        : "unknown"
    }`,
  );
  // Disk encryption — any `crypt` row in lsblk means a LUKS/dm-crypt volume.
  const lsblk = await runCmd(["lsblk", "-rno", "TYPE"]);
  facts.push(`luks ${lsblk ? (lsblk.includes("crypt") ? "1" : "0") : "-1"}`);
  // Pending updates — Ubuntu/Debian update-notifier stamp ("N updates can be
  // applied"). Missing file = unknown (-1), never 0: absence isn't "patched".
  const upd = await readFile("/var/lib/update-notifier/updates-available");
  const m = upd.match(/(\d+)\s+update/);
  facts.push(`updates ${m ? m[1] : "-1"}`);
  return facts.join("\n");
}

export async function sec(): Promise<SecInfo | null> {
  if (PLATFORM === "linux") {
    const [ss, ps, sshd, facts, ...sysctlVals] = await Promise.all([
      runCmd(["ss", "-tulnpH"]),
      runCmd(["ps", "-eo", "pid=,user=,args="]),
      readFile("/etc/ssh/sshd_config"),
      secFactsLinux(),
      ...SYSCTL_CHECKS.map(([, path]) => readFile(path)),
    ]);
    const sysctl = SYSCTL_CHECKS
      .map(([key], i) => [key, (sysctlVals[i] ?? "").trim()] as const)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `${k} ${v}`)
      .join("\n");
    return call<SecInfo>("sys_sec", [ss, ps, sysctl, sshd, facts]);
  }
  if (PLATFORM === "windows") {
    // netstat -ano LISTENING rows → synthesized ss rows (no process names —
    // resolving PIDs would need one query per row).
    const netstat = await runCmd(["netstat", "-ano"]);
    const ss = netstat.split("\n")
      .filter((l) => l.includes("LISTENING"))
      .map((l) => {
        const c = l.trim().split(/\s+/);
        return `tcp LISTEN 0 0 ${c[1] ?? ""} *:*`;
      }).join("\n");
    const sb = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Confirm-SecureBootUEFI",
    ]);
    const facts = `secureboot ${
      sb.includes("True")
        ? "enabled"
        : sb.includes("False")
        ? "disabled"
        : "unknown"
    }`;
    return call<SecInfo>("sys_sec", [ss, "", "", "", facts]);
  }
  // darwin — lsof for listeners, csrutil (SIP), fdesetup (FileVault)
  const lsof = await runCmd(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"]);
  const ss = lsof.split("\n").slice(1).map((l) => {
    const c = l.trim().split(/\s+/);
    const addr = c[8] ?? "";
    return c.length > 8 ? `tcp LISTEN 0 0 ${addr} *:* users:(("${c[0]}"))` : "";
  }).filter(Boolean).join("\n");
  const sip = await runCmd(["csrutil", "status"]);
  const fv = await runCmd(["fdesetup", "status"]);
  const facts = [
    // SIP ≈ the closest analog to Secure Boot's "tampered boot chain" check
    `secureboot ${
      sip.includes("enabled")
        ? "enabled"
        : sip.includes("disabled")
        ? "disabled"
        : "unknown"
    }`,
    `luks ${fv.includes("On") ? "1" : fv.includes("Off") ? "0" : "-1"}`,
  ].join("\n");
  return call<SecInfo>("sys_sec", [ss, "", "", "", facts]);
}

// ── collectAll: run every syscall in parallel, return one bundle ───────────
// The cell's `refresh` method calls this single function. Running in parallel
// via Promise.all keeps the aggregate latency at the slowest syscall (usually
// lspci or df) rather than the sum — and all of it is async, off the dispatch
// loop, so the UI render never blocks.

import type { MachineState } from "./wasm.ts";

export type HardwareSnapshot = Pick<
  MachineState,
  | "cpu"
  | "mem"
  | "dimms"
  | "memSlotsTotal"
  | "board"
  | "gpu"
  | "disk"
  | "lspci"
  | "lsusb"
  | "net"
  | "sys"
  | "sec"
>;

export async function collectAll(): Promise<HardwareSnapshot> {
  const [
    cpuV,
    memV,
    dimmsV,
    boardV,
    gpuV,
    diskV,
    lspciV,
    lsusbV,
    netV,
    sysV,
    secV,
  ] = await Promise
    .all([
      cpu(),
      mem(),
      dimms(),
      board(),
      gpu(),
      disk(),
      lspci(),
      lsusb(),
      net(),
      sys(),
      sec(),
    ]);
  return {
    cpu: cpuV,
    mem: memV,
    dimms: dimmsV.list,
    memSlotsTotal: dimmsV.slots_total,
    board: boardV,
    gpu: gpuV,
    disk: diskV,
    lspci: lspciV ?? [],
    lsusb: lsusbV ?? [],
    net: netV,
    sys: sysV,
    sec: secV,
  };
}
