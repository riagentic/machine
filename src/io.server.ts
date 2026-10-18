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
  try {
    const fnRef = e[fn] as (...args: number[]) => number;
    const outPtr = fnRef(...args.flatMap((a) => [a.ptr, a.len]));
    const out = readOutput(e, outPtr);
    try {
      return JSON.parse(out) as T;
    } catch (err) {
      warnOnce(`${fn} JSON`, String(err));
      return null;
    }
  } finally {
    // free inputs even if the syscall or readOutput threw — a leak here would
    // grow WASM memory on every poll until the module is reloaded.
    args.forEach((a) => e.dealloc(a.ptr, a.len));
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

// Fail loud without spamming the 2s poll: each (site, message) warns once.
const warned = new Set<string>();
function warnOnce(site: string, msg: string): void {
  const k = `${site}\0${msg}`;
  if (warned.has(k)) return;
  warned.add(k);
  console.warn(`[machine] ${site}: ${msg}`);
}

// Optional probes (no hwmon temp, no sshd) legitimately don't exist — only a
// non-ENOENT failure (permission, EIO) is worth a warning.
function ioErr(site: string, e: unknown): void {
  if (!(e instanceof Deno.errors.NotFound)) warnOnce(site, String(e));
}

// Module-level memo (server-only): reuse fn's promise for ttlMs. Caching the
// promise also coalesces concurrent callers into one spawn.
function memo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0;
  let p: Promise<T> | null = null;
  return () => {
    if (!p || Date.now() - at >= ttlMs) {
      at = Date.now();
      p = fn();
    }
    return p;
  };
}

async function readFile(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    ioErr(path, e);
    return "";
  }
}

export async function runCmd(
  cmd: readonly string[],
  opts?: { env?: Record<string, string>; timeoutMs?: number },
): Promise<string> {
  const bin = cmd[0];
  if (!bin) return "";
  // A hung command (stale-NFS df, SIGTERM-ignoring child, grandchild holding
  // stdout) must not wedge the refresh loop forever — `refreshing` would stay
  // true and every later poll would be skipped. Race the output against a
  // timer; on timeout SIGKILL the child and return "" so the next poll retries.
  const timeoutMs = opts?.timeoutMs ?? 4000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = new Deno.Command(bin, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "null",
      env: opts?.env,
    }).spawn();
    const out = await Promise.race([
      child.output(),
      new Promise<null>((r) => timer = setTimeout(() => r(null), timeoutMs)),
    ]);
    if (!out) {
      try {
        child.kill("SIGKILL");
      } catch { /* exited between timeout and kill */ }
      warnOnce(bin, `timed out after ${timeoutMs}ms`);
      return "";
    }
    const text = dec.decode(out.stdout).trim();
    if (!out.success && !text) warnOnce(cmd.join(" "), `exit ${out.code}`);
    return text;
  } catch (e) {
    warnOnce(
      bin,
      e instanceof Deno.errors.NotFound ? "not installed" : String(e),
    );
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// gather hwmon into a textual block: "name\ntempN_input\n..." per device,
// separated by a blank line so WASM parsers can delimit one device from the
// next (sys_board reads temps until the blank line).
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
      // every tempN_input, numerically ordered (temp1 first, gaps allowed)
      const temps: number[] = [];
      for await (const f of Deno.readDir(dir)) {
        const m = f.name.match(/^temp(\d+)_input$/);
        if (m) temps.push(Number(m[1]));
      }
      for (const i of temps.sort((a, b) => a - b)) {
        const v = (await readFile(`${dir}/temp${i}_input`)).trim();
        if (v) out += v + "\n";
      }
      out += "\n"; // blank-line device separator
    }
  } catch (e) {
    ioErr("/sys/class/hwmon", e);
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
  const cpuinfo = await cpuinfoOnce();
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
// Linux /proc/cpuinfo model+cores are static; per-sample reads skip it.
const cpuinfoOnce = memo(Infinity, () => readFile("/proc/cpuinfo"));

// Win/OSX: synthesize cpuinfo once — one "processor" line per logical core so
// the Rust parser (which counts "processor" occurrences) reports the right
// number.
const cpuinfoNonLinux = memo(Infinity, async () => {
  const [name = "", cores = ""] = PLATFORM === "windows"
    ? (await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "$p=Get-CimInstance Win32_Processor; $p[0].Name; ($p | Measure-Object NumberOfLogicalProcessors -Sum).Sum",
    ])).split("\n").map((l) => l.trim())
    : await Promise.all([
      runCmd(["sysctl", "-n", "machdep.cpu.brand_string"]),
      runCmd(["sysctl", "-n", "hw.logicalcpu"]),
    ]);
  const procLines = Array.from(
    { length: Math.max(1, parseInt(cores) || 1) },
    (_, i) => `processor       : ${i}`,
  ).join("\n");
  return `model name      : ${name}\n${procLines}\n`;
});

async function cpuNonLinux(): Promise<CpuInfo | null> {
  const cpuinfo = await cpuinfoNonLinux();
  if (PLATFORM === "windows") {
    // One spawn per sample: util line, then ACPI thermal zone in tenths of
    // Kelvin (root/wmi, admin-only → empty line otherwise).
    const [util = "", tenthsK = ""] = (await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue; (Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentTemperature",
    ])).split("\n").map((l) => l.trim());
    const k = parseFloat(tenthsK);
    // hwmon-style block the parser matches: "core" name + millidegrees C
    const hwmon = k > 0 ? `core\n${Math.round(k * 100 - 273150)}\n` : "";
    const r = await call<CpuInfo>("sys_cpu", [
      cpuinfo,
      `cpu ${util || "0"}`,
      hwmon,
    ]);
    if (r) r.util_pct = Math.max(0, Math.min(100, parseFloat(util) || 0));
    return r;
  }
  // darwin — top's first sample is since-boot, not an interval: take the 2nd
  const util = await runCmd([
    "sh",
    "-c",
    "top -l 2 -s 1 -n 0 | grep 'CPU usage' | tail -1",
  ]);
  // "CPU usage: 12.5% user, 5.2% sys, 82.3% idle" → extract idle → util = 100-idle
  const idleMatch = util.match(/([\d.]+)%\s*idle/);
  const utilPct = idleMatch ? (100 - parseFloat(idleMatch[1] ?? "0")) : 0;
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
// dmidecode is static hardware — run once per process.
export const dimms = memo(Infinity, dimmsUncached);
async function dimmsUncached(): Promise<
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
  // reclaimable = free + inactive + speculative + purgeable pages
  const freePages = [
    ...vmstat.matchAll(
      /Pages (?:free|inactive|speculative|purgeable):\s+(\d+)/g,
    ),
  ].reduce((a, m) => a + (parseInt(m[1] ?? "0") || 0), 0);
  const freeKb = Math.floor((freePages * pageSize) / 1024);
  const totalKb = Math.floor((parseInt(totalBytes) || 0) / 1024);
  const info = `MemTotal:       ${totalKb} kB\nMemAvailable:   ${freeKb} kB\n`;
  const r = await call<MemInfo>("sys_mem", [info]);
  if (r) r.temp_c = 0; // no cheap per-module temp on macOS
  return r;
}

export async function board(): Promise<BoardInfo | null> {
  if (PLATFORM !== "linux") return boardNonLinux();
  // super-I/O chips first (parser prefers them); nvme is a disk, not the board
  const hw = await readHwmonBlock((n) =>
    n.startsWith("nct") || n.startsWith("it87") || n.startsWith("asus") ||
    n.includes("acpi") || n.includes("board")
  );
  const r = await call<BoardInfo>("sys_board", [...await dmiOnce(), hw]);
  // usb_ports is host-stamped (the Rust parser has no USB input): sum of
  // maxchild over root hubs = physical ports on the machine.
  if (r) r.usb_ports = await usbPortCount();
  return r;
}

// DMI strings are static — read once per process.
const dmiOnce = memo(Infinity, () =>
  Promise.all(
    [
      "board_name",
      "board_vendor",
      "board_version",
      "bios_vendor",
      "bios_version",
      "bios_date",
      "product_name",
    ].map(async (f) => (await readFile(`/sys/class/dmi/id/${f}`)).trim()),
  ));

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
  } catch (e) {
    ioErr("/sys/bus/usb/devices", e);
  }
  return n;
}

// Win/OSX board data has no live temps — static, fetch once.
const boardNonLinux = memo(Infinity, boardNonLinuxUncached);
async function boardNonLinuxUncached(): Promise<BoardInfo | null> {
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

// Linux: true when an NVIDIA GPU is bound and awake. nvidia-smi wakes a
// runtime-suspended dGPU (hybrid laptops), so skip it while all sleep.
async function nvidiaAwake(): Promise<boolean> {
  const ids: string[] = [];
  try {
    for await (const e of Deno.readDir("/proc/driver/nvidia/gpus")) {
      ids.push(e.name);
    }
  } catch (e) {
    ioErr("/proc/driver/nvidia/gpus", e);
  }
  for (const id of ids) {
    const st = await readFile(
      `/sys/bus/pci/devices/${id}/power/runtime_status`,
    );
    if (st.trim() !== "suspended") return true;
  }
  return false;
}

export async function gpu(): Promise<GpuInfo | null> {
  // nvidia-smi works on Linux/Windows when present (no NVIDIA on modern OSX)
  const nvidia = PLATFORM === "darwin" ||
      (PLATFORM === "linux" && !await nvidiaAwake())
    ? ""
    : await runCmd([
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
        } catch (e) {
          ioErr(hwmonDir, e); // connectors (cardN-DP-1) have no hwmon: ENOENT
        }
      }
    } catch (e) {
      ioErr("/sys/class/drm", e);
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
    // -l: local filesystems only — a stale NFS mount would hang df
    const df = await runCmd(["df", "-l", "-P", "-B1"]);
    return call<DiskInfo>("sys_disk", [df]);
  }
  if (PLATFORM === "windows") {
    // Windows: Get-Volume returns size/free; synthesize df -P format
    const out = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-Volume | Where-Object { $_.DriveLetter -and $_.Size } | ForEach-Object { '{0} {1} {2}' -f $_.DriveLetter,$_.Size,$_.SizeRemaining }",
    ]);
    // reformat into df -P columns: Filesystem 1B-blocks Used Available Capacity% MountedOn
    // (the parser treats mount "C:" as root)
    const lines = out.split("\n").filter(Boolean).map((l) => {
      const [letter, sizeS, freeS] = l.trim().split(/\s+/);
      const size = Number(sizeS) || 0;
      const free = Number(freeS) || 0;
      const pct = size ? ((size - free) / size * 100).toFixed(1) : "0";
      return `${letter}: ${size} ${size - free} ${free} ${pct}% ${letter}:`;
    }).join("\n");
    return call<DiskInfo>("sys_disk", [lines]);
  }
  // darwin — df -g works but in GB blocks; use -k for kB
  const df = await runCmd(["df", "-l", "-P", "-k"]);
  // convert kB df to B for consistent units: multiply size/used/avail by 1024
  const lines = df.split("\n").map((l) => {
    const cols = l.split(/\s+/);
    if (cols.length < 6 || cols[1] === "1024-blocks") return l;
    const [totalB, usedB, availB] = [1, 2, 3].map((i) =>
      (parseInt(cols[i] ?? "0") || 0) * 1024
    );
    return `${cols[0]} ${totalB} ${usedB} ${availB} ${cols[4]} ${
      cols.slice(5).join(" ")
    }`;
  }).join("\n");
  return call<DiskInfo>("sys_disk", [lines]);
}

// `lspci -nnmm`-style line the Rust parser reads: slot "class" "vendor" "name"
const mmLine = (fields: string[]) =>
  `- ${fields.map((f) => `"${f.trim().replaceAll('"', "'")}"`).join(" ")}`;

// Device lists change only on hotplug — refresh at most every 30s.
export const lspci = memo(30_000, lspciUncached);
async function lspciUncached(): Promise<LspciEntry[] | null> {
  if (PLATFORM === "linux") {
    const raw = await runCmd(["lspci", "-nnmm"]);
    return call<LspciEntry[]>("sys_lspci", [raw]);
  }
  if (PLATFORM === "windows") {
    // Win32_PnPEntity filtered to PCI devices, tab-separated class/vendor/name
    const out = await runCmd([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'PCI\\*' } | ForEach-Object { \"$($_.PNPClass)`t$($_.Manufacturer)`t$($_.Name)\" }",
    ]);
    const lines = out.split("\n").filter((l) => l.trim())
      .map((l) => mmLine(l.split("\t"))).join("\n");
    return call<LspciEntry[]>("sys_lspci", [lines]);
  }
  // darwin — system_profiler JSON (often empty on Apple Silicon → [])
  const out = await runCmd(["system_profiler", "-json", "SPPCIDataType"]);
  let devs: Record<string, string>[] = [];
  try {
    devs = out ? JSON.parse(out).SPPCIDataType ?? [] : [];
  } catch (e) {
    warnOnce("system_profiler SPPCIDataType", String(e));
  }
  const lines = devs.map((d) =>
    mmLine([
      d["sppci_device_type"] ?? "",
      d["sppci_vendor-id"] ?? "",
      d["_name"] ?? "",
    ])
  ).join("\n");
  return call<LspciEntry[]>("sys_lspci", [lines]);
}

export const lsusb = memo(30_000, lsusbUncached);
async function lsusbUncached(): Promise<LsusbEntry[] | null> {
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
    const [addrs, links, route, fw] = await Promise.all([
      runCmd(["ip", "-j", "-br", "addr"]),
      runCmd(["ip", "-j", "-br", "link"]),
      runCmd(["ip", "route", "show", "default"]),
      detectFirewallState(),
    ]);
    const speedInfo = await readNetSpeed(route);
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
    const fw = `defender:${parseInt(fwState) > 0 ? "active" : "inactive"}`;
    const vpn = addrs.includes("WAN") || addrs.includes("RAS");
    const links = vpn ? '[{"ifname":"tun0","operstate":"UP"}]' : "[]";
    const speedInfo = readNetSpeedWindows();
    return call<NetInfo>("sys_net", [addrs, links, route, fw, speedInfo]);
  }
  // darwin — ifconfig text → `ip -j -br addr`-shaped JSON array
  const ifconfig = await runCmd(["ifconfig"]);
  const ifaces = ifconfig.split(/\n(?=\S)/).filter(Boolean).map((b) => ({
    ifname: b.split(":")[0] ?? "",
    addr_info: [...b.matchAll(/\binet6?\s+(\S+)/g)].map((m) => ({
      local: m[1],
    })),
  }));
  const route = await runCmd(["netstat", "-rn", "-f", "inet"]);
  const pf = await runCmd(["pfctl", "-s", "info"]);
  const fw = `pf:${pf.includes("Status: Enabled") ? "active" : "inactive"}`;
  // system utunN tunnels (iCloud etc.) carry only IPv6 — a VPN has IPv4
  const vpn = ifaces.some((i) =>
    /^(utun|ppp|ipsec)/.test(i.ifname) &&
    i.addr_info.some((a) => a.local?.includes("."))
  );
  const links = vpn ? '[{"ifname":"tun0","operstate":"UP"}]' : "[]";
  const speedInfo = readNetSpeedDarwin();
  return call<NetInfo>("sys_net", [
    JSON.stringify(ifaces),
    links,
    route,
    fw,
    speedInfo,
  ]);
}

// Network speed: read link max (Mbps) from /sys/class/net/IFACE/speed and
// rx/tx byte counters from /sys/class/net/IFACE/statistics. The cell computes
// the rate (Mbps) from the byte delta between samples. We stash the raw byte
// counts in rx_mbps/tx_mbps — the cell converts to rates.
async function readNetSpeed(route: string): Promise<string> {
  // the default-route interface (the one actually in use)
  const ifaceMatch = route.match(/dev\s+(\S+)/);
  const iface = ifaceMatch?.[1] ?? "eth0";
  const speed = await readFile(`/sys/class/net/${iface}/speed`);
  const rxBytes = await readFile(`/sys/class/net/${iface}/statistics/rx_bytes`);
  const txBytes = await readFile(`/sys/class/net/${iface}/statistics/tx_bytes`);
  const linkMax = parseInt(speed.trim()) || 0;
  const rx = parseInt(rxBytes.trim()) || 0;
  const tx = parseInt(txBytes.trim()) || 0;
  // rx_mbps/tx_mbps carry RAW BYTE COUNTS here — the cell computes the rate
  // from the delta. link_max_mbps is the link speed cap. iface is the
  // interface those counters belong to, so the cell can drop the delta when
  // the default route (and its counters) switches mid-sample.
  return JSON.stringify({
    link_max_mbps: linkMax,
    rx_mbps: rx,
    tx_mbps: tx,
    iface,
    ts: Date.now(),
  });
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

// "<backend>:active|inactive" | "none", root-free. ufw.service stays
// "active" even when ufw is disabled, so ufw also needs ENABLED=yes. A bare
// nft ruleset (docker's NAT) is not a firewall — only the nftables service.
async function detectFirewallState(): Promise<string> {
  const [ufw = "", firewalld = "", nftables = ""] = (await runCmd([
    "systemctl",
    "is-active",
    "ufw",
    "firewalld",
    "nftables",
  ])).split("\n");
  const ufwConf = await readFile("/etc/ufw/ufw.conf");
  if (ufw === "active" && /^ENABLED=yes/m.test(ufwConf)) return "ufw:active";
  if (firewalld === "active") return "firewalld:active";
  if (nftables === "active") return "nftables:active";
  return ufwConf ? "ufw:inactive" : "none";
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

const mokOnce = memo(Infinity, () => runCmd(["mokutil", "--sb-state"]));

// sshd_config with `Include` lines replaced by the matching files (sorted,
// relative to /etc/ssh, `*`/`?` globs in the basename) — sshd semantics.
// Exported (with runCmd) for test/io.test.ts.
export async function sshdConfig(path: string, depth = 0): Promise<string> {
  const text = await readFile(path);
  if (depth > 8) return text; // sshd's own nesting cap is similar
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*Include\s+(.+)$/i);
    if (!m) {
      out.push(line);
      continue;
    }
    for (const pat of (m[1] ?? "").trim().split(/\s+/)) {
      const full = pat.startsWith("/") ? pat : `/etc/ssh/${pat}`;
      const i = full.lastIndexOf("/");
      const dir = full.slice(0, i);
      const re = new RegExp(
        "^" + full.slice(i + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*").replaceAll("?", ".") +
          "$",
      );
      const names: string[] = [];
      try {
        for await (const e of Deno.readDir(dir)) {
          if (re.test(e.name)) names.push(e.name);
        }
      } catch (e) {
        ioErr(dir, e);
      }
      for (const n of names.sort()) {
        out.push(await sshdConfig(`${dir}/${n}`, depth + 1));
      }
    }
  }
  return out.join("\n");
}

async function secFactsLinux(): Promise<string> {
  const facts: string[] = [];
  // Secure Boot — mokutil is the portable answer; efivars fallback needs root.
  const mok = await mokOnce();
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

// ss -p/ps -e/lsblk are the costliest spawns — the posture bundle refreshes
// at most every 30s.
export const sec = memo(30_000, secUncached);
async function secUncached(): Promise<SecInfo | null> {
  if (PLATFORM === "linux") {
    const [ss, ps, sshd, facts, ...sysctlVals] = await Promise.all([
      runCmd(["ss", "-tulnpH"]),
      runCmd(["ps", "-eo", "pid=,user=,args="]),
      sshdConfig("/etc/ssh/sshd_config"),
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

export type HardwareSnapshot =
  & Pick<
    MachineState,
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
  >
  & { wasmAvailable: boolean };

export async function collectAll(): Promise<HardwareSnapshot> {
  const [
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
    // wasmAvailable reflects whether the WASM module actually loaded, NOT
    // whether every panel has data. A panel legitimately returning null (no
    // GPU, no dmidecode, non-Linux) must not flip the badge to "wasm off" or
    // raise a false CRIT issue.
    wasmAvailable: (await load()) !== null,
  };
}
