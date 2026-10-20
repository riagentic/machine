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

// Static facts: keep a good answer forever; a failed one (null) retries after
// retryMs, so one cold/slow first read never sticks for the whole run.
function onceOk<T>(
  fn: () => Promise<T | null>,
  fallback: T,
  retryMs = 60_000,
): () => Promise<T> {
  let p: Promise<T | null> | null = null;
  let failedAt = 0;
  return async () => {
    if (!p && Date.now() - failedAt < retryMs) return fallback;
    p ??= fn();
    const v = await p;
    if (v !== null) return v;
    p = null;
    failedAt = Date.now();
    return fallback;
  };
}

// PowerShell JSON flattens a one-item array to the bare item and an empty
// one to null — normalize every list it hands back.
export const toArr = <T>(v: T | T[] | null | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

function parseJson<T>(site: string, text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    warnOnce(`${site} JSON`, String(e));
    return null;
  }
}

// ── Windows: one long-lived PowerShell ─────────────────────────────────────
// powershell.exe costs ~0.3s CPU just to start, and the poll needs several
// queries. One session reads one-line scripts from stdin; each reply ends at
// a unique marker. Requests run one at a time (queue). A script that throws
// warns once and yields ""; a hung one kills the session (the next request
// starts a fresh one) — the same never-throw contract as runCmd.
type PsSession = {
  child: Deno.ChildProcess;
  w: WritableStreamDefaultWriter<Uint8Array>;
  r: ReadableStreamDefaultReader<string>;
  buf: string;
};
let psSession: PsSession | null = null;
let psQueue: Promise<unknown> = Promise.resolve();
let psSeq = 0;

function psOpen(): PsSession {
  const child = new Deno.Command("powershell", {
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "-",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  // Not unref()'d: an unref'd child's pipe reads don't hold the event loop,
  // so an awaited reply could be dropped. aio exits via Deno.exit, which
  // closes stdin — PowerShell ends on that EOF.
  const s: PsSession = {
    child,
    w: child.stdin.getWriter(),
    r: child.stdout.pipeThrough(new TextDecoderStream()).getReader(),
    buf: "",
  };
  // Stop: a failing cmdlet throws into the per-request catch (fail loud);
  // optional probes opt out with -ErrorAction SilentlyContinue.
  s.w.write(enc.encode(
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $WarningPreference='SilentlyContinue'; $VerbosePreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n",
  )).catch(() => {}); // a dead session surfaces on the first request
  return s;
}

async function psShut(s: PsSession): Promise<void> {
  if (psSession === s) psSession = null;
  try {
    s.child.kill("SIGKILL");
  } catch { /* already exited */ }
  await Promise.allSettled([s.w.close(), s.r.cancel(), s.child.status]);
}

/** Run a one-line PowerShell script in the shared session; "" on failure. */
export function pwsh(script: string, timeoutMs = 10_000): Promise<string> {
  const site = `powershell ${script.slice(0, 48)}…`;
  const run = async (): Promise<string> => {
    let s: PsSession;
    try {
      s = psSession ??= psOpen();
    } catch (e) {
      warnOnce(
        "powershell",
        e instanceof Deno.errors.NotFound ? "not installed" : String(e),
      );
      return "";
    }
    const end = `__machine_end_${++psSeq}__`;
    const work = (async () => {
      // The marker goes on its own line: a parse error skips the whole
      // script line, and the missing __machine_ok__ then says so.
      await s.w.write(enc.encode(
        `try { ${script} } catch { Write-Output ('__machine_err__ ' + $_) }; Write-Output '__machine_ok__'\nWrite-Output '${end}'\n`,
      ));
      let i: number;
      while ((i = s.buf.indexOf(end)) < 0) {
        const { value, done } = await s.r.read();
        if (done) throw new Error("session exited");
        s.buf += value;
      }
      const out = s.buf.slice(0, i);
      s.buf = s.buf.slice(i + end.length).replace(/^\r?\n/, "");
      return out;
    })();
    work.catch(() => {}); // a timed-out read rejects after the race is over
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        work,
        new Promise<null>((r) => timer = setTimeout(() => r(null), timeoutMs)),
      ]);
      if (out === null) {
        warnOnce(site, `timed out after ${timeoutMs}ms`);
        await psShut(s);
        return "";
      }
      const err = out.match(/__machine_err__ (.*)/);
      if (err || !out.includes("__machine_ok__")) {
        warnOnce(site, err?.[1] ?? "script did not run (parse error?)");
        return "";
      }
      return out.replace("__machine_ok__", "").replace(/\r/g, "").trim();
    } catch (e) {
      warnOnce(site, String(e));
      await psShut(s);
      return "";
    } finally {
      clearTimeout(timer);
    }
  };
  const p = psQueue.then(run); // run never rejects — the queue never breaks
  psQueue = p;
  return p;
}

/** Release host resources (the PowerShell session) — for tests and exit. */
export async function closeHost(): Promise<void> {
  await psQueue;
  if (psSession) await psShut(psSession);
}

// ── Win/OSX: native per-core CPU tick counters (FFI) ───────────────────────
// The 1s sampler must not start a process per tick. Windows'
// NtQuerySystemInformation and macOS' host_processor_info return per-core
// user/kernel/idle ticks; procStat() shapes them as /proc/stat lines so all
// three OSes share the cell's delta math. No allocation per Windows call;
// macOS hands back a buffer we vm_deallocate every time.
export type Ticks = { user: number; sys: number; idle: number };

/** /proc/stat-shaped text: aggregate line, then cpuN (field 4 = idle). */
export function procStat(cores: Ticks[]): string {
  if (cores.length === 0) return "";
  const line = (name: string, t: Ticks) =>
    `${name} ${t.user} 0 ${t.sys} ${t.idle}`;
  const sum = cores.reduce((a, t) => ({
    user: a.user + t.user,
    sys: a.sys + t.sys,
    idle: a.idle + t.idle,
  }), { user: 0, sys: 0, idle: 0 });
  return [line("cpu ", sum), ...cores.map((t, i) => line(`cpu${i}`, t))]
    .join("\n");
}

function winTicks(): () => Ticks[] {
  const lib = Deno.dlopen("ntdll.dll", {
    NtQuerySystemInformation: {
      parameters: ["u32", "buffer", "u32", "buffer"],
      result: "i32",
    },
  });
  // SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION: 48 bytes per logical CPU
  // (IdleTime, KernelTime ⊇ idle, UserTime as 100ns i64s, then DPC/IRQ).
  const buf = new Uint8Array(48 * Math.max(64, navigator.hardwareConcurrency));
  const len = new Uint32Array(1);
  const v = new DataView(buf.buffer);
  return () => {
    const st = lib.symbols.NtQuerySystemInformation(8, buf, buf.length, len);
    if (st !== 0) {
      throw new Error(`NtQuerySystemInformation 0x${(st >>> 0).toString(16)}`);
    }
    return Array.from({ length: (len[0] ?? 0) / 48 }, (_, i) => {
      const idle = Number(v.getBigInt64(i * 48, true));
      const kernel = Number(v.getBigInt64(i * 48 + 8, true));
      return {
        user: Number(v.getBigInt64(i * 48 + 16, true)),
        sys: kernel - idle,
        idle,
      };
    });
  };
}

function macTicks(): () => Ticks[] {
  const lib = Deno.dlopen("/usr/lib/libSystem.B.dylib", {
    mach_host_self: { parameters: [], result: "u32" },
    host_processor_info: {
      parameters: ["u32", "i32", "buffer", "buffer", "buffer"],
      result: "i32",
    },
    vm_deallocate: { parameters: ["u32", "usize", "usize"], result: "i32" },
    mach_task_self_: { type: "u32" },
  });
  const host = lib.symbols.mach_host_self();
  const task = lib.symbols.mach_task_self_;
  const cpus = new Uint32Array(1);
  const info = new BigUint64Array(1);
  const words = new Uint32Array(1);
  return () => {
    // PROCESSOR_CPU_LOAD_INFO = 2 → per CPU: user, system, idle, nice ticks
    const kr = lib.symbols.host_processor_info(host, 2, cpus, info, words);
    if (kr !== 0) throw new Error(`host_processor_info kr=${kr}`);
    const addr = info[0] ?? 0n;
    try {
      const t = new Uint32Array(
        Deno.UnsafePointerView.getArrayBuffer(
          Deno.UnsafePointer.create(addr)!,
          (words[0] ?? 0) * 4,
        ).slice(0),
      );
      return Array.from({ length: cpus[0] ?? 0 }, (_, i) => ({
        user: (t[i * 4] ?? 0) + (t[i * 4 + 3] ?? 0),
        sys: t[i * 4 + 1] ?? 0,
        idle: t[i * 4 + 2] ?? 0,
      }));
    } finally {
      lib.symbols.vm_deallocate(task, addr, BigInt((words[0] ?? 0) * 4));
    }
  };
}

let readTicks: (() => Ticks[]) | null | undefined; // undefined = not opened
function nativeTicks(): Ticks[] {
  if (readTicks === undefined) {
    try {
      readTicks = PLATFORM === "windows" ? winTicks() : macTicks();
    } catch (e) {
      warnOnce("cpu ticks (ffi)", String(e));
      readTicks = null;
    }
  }
  if (!readTicks) return [];
  try {
    return readTicks();
  } catch (e) {
    warnOnce("cpu ticks", String(e));
    return [];
  }
}

// ── Win/OSX: static inventory (read once) ──────────────────────────────────
// Everything that never changes while the app runs, in ONE query per OS:
// CPU, board/firmware, memory modules, GPUs (+VRAM), OS name. Mapped by pure
// functions (exported for tests) into the shapes the panels expect.
export type Inventory = {
  cpu: { model: string; threads: number; max_mhz: number };
  // sys_board input order: name, vendor, version, bios vendor, bios version,
  // bios date, product
  board: string[];
  dimms: { list: DimmInfo[]; slots_total: number };
  gpus: { name: string; vram_mb: number }[];
  os_name: string;
};
const NO_INVENTORY: Inventory = {
  cpu: { model: "", threads: 0, max_mhz: 0 },
  board: [],
  dimms: { list: [], slots_total: 0 },
  gpus: [],
  os_name: "",
};

const str = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";

// SMBIOS memory type codes (Win32_PhysicalMemory.SMBIOSMemoryType)
const SMBIOS_MEM: Record<number, string> = {
  18: "DDR",
  19: "DDR2",
  20: "DDR2 FB-DIMM",
  24: "DDR3",
  26: "DDR4",
  27: "LPDDR",
  28: "LPDDR2",
  29: "LPDDR3",
  30: "LPDDR4",
  34: "DDR5",
  35: "LPDDR5",
};

const gb = (bytes: number) => `${Math.round(bytes / 2 ** 30)} GB`;

type WinInv = {
  cpu?: string;
  threads?: number;
  mhz?: number;
  bn?: string;
  bv?: string;
  bver?: string;
  biv?: string;
  bivr?: string;
  bd?: string;
  model?: string;
  os?: string;
  slots?: number;
  mem?: { l?: string; c?: string; s?: number; t?: number }[];
  gpu?: { n?: string; r?: string }[];
};
export function winInventory(j: WinInv): Inventory {
  return {
    cpu: {
      model: str(j.cpu),
      threads: j.threads ?? 0,
      max_mhz: j.mhz ?? 0,
    },
    board: [j.bn, j.bv, j.bver, j.biv, j.bivr, j.bd, j.model].map(str),
    dimms: {
      list: toArr(j.mem).map((m) => ({
        locator: str(m.l),
        size: gb(Number(m.c) || 0),
        speed: m.s ? `${m.s} MT/s` : "",
        type: SMBIOS_MEM[m.t ?? 0] ?? "",
      })),
      slots_total: j.slots ?? 0,
    },
    gpus: toArr(j.gpu).map((g) => ({
      name: str(g.n),
      vram_mb: Math.round((Number(g.r) || 0) / 2 ** 20),
    })),
    os_name: str(j.os),
  };
}

const WIN_INVENTORY = [
  "$p=@(Get-CimInstance Win32_Processor)",
  "$b=Get-CimInstance Win32_BaseBoard",
  "$bi=Get-CimInstance Win32_BIOS",
  "$cs=Get-CimInstance Win32_ComputerSystem",
  "$os=Get-CimInstance Win32_OperatingSystem",
  "$mem=@(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{l=$_.DeviceLocator; c=[string]$_.Capacity; s=$_.ConfiguredClockSpeed; t=$_.SMBIOSMemoryType} })",
  "$slots=(Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object MemoryDevices -Sum).Sum",
  // AdapterRAM is a uint32 (caps at 4 GiB); the driver's qwMemorySize is not
  "$vr=@{}; Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object { $q=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($q.'HardwareInformation.qwMemorySize') { $vr[[string]$q.DriverDesc]=[string]$q.'HardwareInformation.qwMemorySize' } }",
  "$gpu=@(Get-CimInstance Win32_VideoController | ForEach-Object { @{n=$_.Name; r=$(if ($vr[[string]$_.Name]) { $vr[[string]$_.Name] } else { [string]$_.AdapterRAM })} })",
  "ConvertTo-Json -Compress -Depth 4 -InputObject @{cpu=$p[0].Name; threads=($p | Measure-Object NumberOfLogicalProcessors -Sum).Sum; mhz=$p[0].MaxClockSpeed; bn=$b.Product; bv=$b.Manufacturer; bver=$b.Version; biv=$bi.Manufacturer; bivr=$bi.SMBIOSBIOSVersion; bd=$(if ($bi.ReleaseDate) { $bi.ReleaseDate.ToString('yyyy-MM-dd') } else { '' }); model=$cs.Model; os=$os.Caption; slots=$slots; mem=$mem; gpu=$gpu}",
].join("; ");

const sizeMb = (s: string): number => {
  const m = s.match(/([\d.]+)\s*(GB|MB)/i);
  return m
    ? Math.round(parseFloat(m[1] ?? "0") * (/g/i.test(m[2] ?? "") ? 1024 : 1))
    : 0;
};

type Rec = Record<string, unknown>;
export function macInventory(ctl: string, prof: string, sw: string): Inventory {
  const ctlKey = (k: string) =>
    ctl.match(new RegExp(`^${k.replaceAll(".", "\\.")}:\\s*(.+)$`, "m"))?.[1]
      ?.trim() ?? "";
  const p = parseJson<Record<string, Rec[]>>("system_profiler", prof) ?? {};
  const hw = p.SPHardwareDataType?.[0] ?? {};
  const mem = p.SPMemoryDataType ?? [];
  // Intel Macs list slots under _items; Apple Silicon has one unified entry
  const slots = mem.flatMap((m) => toArr(m._items as Rec[] | undefined));
  const swKey = (k: string) =>
    sw.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  return {
    cpu: {
      model: ctlKey("machdep.cpu.brand_string") || str(hw.chip_type),
      threads: parseInt(ctlKey("hw.logicalcpu")) || 0,
      max_mhz: (parseInt(ctlKey("hw.cpufrequency_max")) || 0) / 1e6,
    },
    board: [
      str(hw.machine_model),
      "Apple",
      "",
      "Apple",
      str(hw.boot_rom_version),
      "",
      str(hw.machine_name),
    ],
    dimms: slots.length > 0
      ? {
        list: slots
          .filter((d) => str(d.dimm_size) && !/empty/i.test(str(d.dimm_size)))
          .map((d) => ({
            locator: str(d._name),
            size: str(d.dimm_size),
            speed: str(d.dimm_speed),
            type: str(d.dimm_type),
          })),
        slots_total: slots.length,
      }
      : {
        list: mem.filter((m) => str(m.SPMemoryDataType)).map((m) => ({
          locator: "unified",
          size: str(m.SPMemoryDataType),
          speed: "",
          type: str(m.dimm_type),
        })),
        slots_total: 0,
      },
    gpus: (p.SPDisplaysDataType ?? []).map((g) => ({
      name: str(g.sppci_model) || str(g._name),
      vram_mb: sizeMb(str(g.spdisplays_vram)),
    })),
    os_name: `${swKey("ProductName")} ${swKey("ProductVersion")}`.trim(),
  };
}

const inventory = onceOk<Inventory>(async () => {
  if (PLATFORM === "windows") {
    const j = parseJson<WinInv>("inventory", await pwsh(WIN_INVENTORY, 60_000));
    return j?.cpu ? winInventory(j) : null;
  }
  if (PLATFORM !== "darwin") return null;
  const [ctl, prof, sw] = await Promise.all([
    // the Intel-only key goes last: an unknown oid must not hide the others
    runCmd([
      "sysctl",
      "machdep.cpu.brand_string",
      "hw.logicalcpu",
      "hw.cpufrequency_max",
    ]),
    runCmd([
      "system_profiler",
      "-json",
      "SPHardwareDataType",
      "SPMemoryDataType",
      "SPDisplaysDataType",
    ], { timeoutMs: 30_000 }),
    runCmd(["sw_vers"]),
  ]);
  const inv = macInventory(ctl, prof, sw);
  return inv.cpu.model ? inv : null;
}, NO_INVENTORY);

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
// FFI tick counters + one long-lived PowerShell; OSX uses FFI +
// sysctl/system_profiler/ioreg/netstat.

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

// Linux /proc/cpuinfo model+cores are static; per-sample reads skip it.
const cpuinfoOnce = memo(Infinity, () => readFile("/proc/cpuinfo"));

// Win/OSX: per-core ticks via FFI (no process per tick) + a cpuinfo-like
// text from the inventory — one "processor" line per logical core (the Rust
// parser counts them).
async function cpuNonLinux(): Promise<CpuInfo | null> {
  const { cpu } = await inventory();
  const ticks = nativeTicks();
  const tempC = cpuTempWin();
  // count what the counters report (NtQuery sees one ≤64-CPU group)
  const procLines = Array.from(
    { length: Math.max(1, ticks.length || cpu.threads) },
    (_, i) => `processor       : ${i}`,
  ).join("\n");
  // hwmon-style block the parser matches: "core" name + millidegrees C
  const hwmon = tempC > 0 ? `core\n${Math.round(tempC * 1000)}\n` : "";
  return call<CpuInfo>("sys_cpu", [
    `model name      : ${cpu.model}\n${procLines}\n`,
    procStat(ticks),
    hwmon,
  ]);
}

// Windows ACPI thermal zone (tenths of Kelvin) — admin-only, and often a
// board zone, but the only unprivileged-API reading there is. macOS has no
// unprivileged sensor API (powermetrics needs root) → 0 = "—".
// Never awaited by the 1s sampler (the session queue may be busy with a slow
// scan): returns the last reading and refreshes it in the background ≤ 5s.
let winTemp = { c: 0, at: 0, busy: false };
function cpuTempWin(): number {
  if (PLATFORM !== "windows") return 0;
  if (!winTemp.busy && Date.now() - winTemp.at >= 5_000) {
    winTemp = { ...winTemp, busy: true };
    pwsh(
      "[int](Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentTemperature",
    ).then((v) => {
      const k = parseInt(v);
      winTemp = { c: k > 0 ? k / 10 - 273.15 : 0, at: Date.now(), busy: false };
    });
  }
  return winTemp.c;
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
  if (PLATFORM !== "linux") return (await inventory()).dimms;
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

// Win/OSX: the OS's own figures (Deno asks the kernel directly — no spawn).
async function memNonLinux(): Promise<MemInfo | null> {
  const m = Deno.systemMemoryInfo();
  // Deno 2.9 on Windows reports available=0; its `free` is ullAvailPhys —
  // the OS's own "available" (CI-verified)
  const avail = PLATFORM === "windows" ? m.free : m.available;
  const kb = (b: number) => Math.round(b / 1024);
  const r = await call<MemInfo>("sys_mem", [
    `MemTotal:       ${kb(m.total)} kB\nMemAvailable:   ${kb(avail)} kB\n`,
  ]);
  if (r) r.temp_c = 0; // no unprivileged per-module temps on Win/OSX
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

// Win/OSX board data is static (no live temps) — from the inventory.
async function boardNonLinux(): Promise<BoardInfo | null> {
  const { board } = await inventory();
  if (board.length === 0) return null;
  const r = await call<BoardInfo>("sys_board", [...board, ""]);
  if (r) r.usb_ports = 0; // no cheap port count on Win/OSX; UI shows "—"
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
  } else {
    // Win/OSX: names + VRAM from the inventory (NVIDIA cards already came
    // from nvidia-smi); utilization is a live read.
    const others = (await inventory()).gpus.filter((g) =>
      !(nvidia && /nvidia/i.test(g.name))
    );
    const util = await gpuUtilNonLinux(others.length, nvidia !== "");
    hw = others.map((g, i) => `${g.name}\n0\n${util[i] ?? 0}\n0\n`).join("");
    const r = await call<GpuInfo>("sys_gpu", [nvidia, hw]);
    // hwmon-block GPUs follow the nvidia-smi ones; stamp their VRAM size
    const first = (r?.gpus.length ?? 0) - others.length;
    others.forEach((g, i) => {
      const out = r?.gpus[first + i];
      if (out) out.mem_total_mb = g.vram_mb;
    });
    return r;
  }
  return call<GpuInfo>("sys_gpu", [nvidia, hw]);
}

// a WMI perf-class query is not free — at most every 5s
const winGpuUtil = memo(5_000, async () =>
  Math.min(
    100,
    parseInt(
      await pwsh(
        "[int](Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Where-Object Name -like '*engtype_3D' | Measure-Object UtilizationPercentage -Sum).Sum",
      ),
    ) || 0,
  ));

// Non-NVIDIA GPU utilization %, one entry per inventory GPU (in order) —
// only where it can be attributed: Windows' 3D-engine counter sums every
// adapter, so it is used when there is exactly one GPU in the box; macOS'
// IOAccelerator lists one "Device Utilization %" per GPU.
async function gpuUtilNonLinux(
  n: number,
  hasNvidia: boolean,
): Promise<number[]> {
  if (n === 0) return [];
  if (PLATFORM === "windows") {
    return n === 1 && !hasNvidia ? [await winGpuUtil()] : [];
  }
  const io = await runCmd([
    "ioreg",
    "-r",
    "-d",
    "1",
    "-w",
    "0",
    "-c",
    "IOAccelerator",
  ]);
  const u = [...io.matchAll(/"Device Utilization %"=(\d+)/g)].map((m) =>
    Math.min(100, parseInt(m[1] ?? "0") || 0)
  );
  return u.length === n ? u : n === 1 && u.length > 0 ? [Math.max(...u)] : [];
}

export async function disk(): Promise<DiskInfo | null> {
  if (PLATFORM === "linux") {
    // -l: local filesystems only — a stale NFS mount would hang df
    const df = await runCmd(["df", "-l", "-P", "-B1"]);
    return call<DiskInfo>("sys_disk", [df]);
  }
  if (PLATFORM === "windows") {
    return call<DiskInfo>("sys_disk", [await winVolumes()]);
  }
  return call<DiskInfo>("sys_disk", [
    macDf(await runCmd(["df", "-l", "-P", "-k"])),
  ]);
}

// Volume fill changes slowly — Windows re-reads every 10s. Synthesizes
// `df -P` columns (Filesystem 1B-blocks Used Available Capacity Mounted);
// the parser treats mount "C:" as root.
const winVolumes = memo(10_000, async () =>
  (await pwsh(
    "Get-Volume | Where-Object { $_.DriveLetter -and $_.Size } | ForEach-Object { '{0} {1} {2}' -f $_.DriveLetter,$_.Size,$_.SizeRemaining }",
  )).split("\n").filter((l) => l.trim()).map((l) => {
    const [letter, sizeS, freeS] = l.trim().split(/\s+/);
    const size = Number(sizeS) || 0;
    const free = Number(freeS) || 0;
    const pct = size ? ((size - free) / size * 100).toFixed(1) : "0";
    return `${letter}: ${size} ${size - free} ${free} ${pct}% ${letter}:`;
  }).join("\n"));

/**
 * macOS `df -P -k` → byte columns, APFS-aware: "/" is the sealed read-only
 * system snapshot (a few GB used) while the user's files live on
 * /System/Volumes/Data — report that as "/", and drop the other system
 * volumes (VM, Preboot, Update…) that share the same container.
 */
export function macDf(df: string): string {
  const rows = df.split("\n").map((l) => l.split(/\s+/)).filter((c) =>
    c.length >= 6 && /^\d+$/.test(c[1] ?? "")
  ).map((c) => ({ c, mp: c.slice(5).join(" ") }));
  const hasData = rows.some((r) => r.mp === "/System/Volumes/Data");
  return rows
    .filter((r) =>
      !(r.mp.startsWith("/System/Volumes/") &&
        r.mp !== "/System/Volumes/Data") &&
      !(hasData && r.mp === "/")
    )
    .map(({ c, mp }) => {
      const [total, used, avail] = [1, 2, 3].map((i) =>
        (parseInt(c[i] ?? "0") || 0) * 1024
      );
      return `${c[0]} ${total} ${used} ${avail} ${c[4]} ${
        mp === "/System/Volumes/Data" ? "/" : mp
      }`;
    }).join("\n");
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
    return call<LspciEntry[]>("sys_lspci", [winPnp(await winDevices()).pci]);
  }
  // darwin — system_profiler JSON (often empty on Apple Silicon → [])
  const out = await runCmd(["system_profiler", "-json", "SPPCIDataType"], {
    timeoutMs: 15_000,
  });
  const devs = parseJson<{ SPPCIDataType?: Rec[] }>("SPPCIDataType", out)
    ?.SPPCIDataType ?? [];
  const lines = devs.map((d) =>
    mmLine([
      str(d["sppci_device_type"]),
      str(d["sppci_vendor"]) || str(d["sppci_vendor-id"]),
      str(d["_name"]),
    ])
  ).join("\n");
  return call<LspciEntry[]>("sys_lspci", [lines]);
}

// Windows: ONE Win32_PnPEntity scan (slow, ~1s) feeds both lspci and lsusb.
type PnpDev = { id?: string; c?: string; v?: string; n?: string };
const winDevices = memo(30_000, async () =>
  toArr(parseJson<PnpDev | PnpDev[]>(
    "Win32_PnPEntity",
    await pwsh(
      "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'PCI\\*' -or $_.PNPDeviceID -like 'USB\\VID_*' } | ForEach-Object { @{id=[string]$_.PNPDeviceID; c=[string]$_.PNPClass; v=[string]$_.Manufacturer; n=[string]$_.Name} })",
      20_000,
    ),
  )));

/** PnP devices → `lspci -nnmm` / `lsusb` text. USB interface children
 *  (`&MI_xx`) collapse into their device; ids are real VID:PID. */
export function winPnp(devs: PnpDev[]): { pci: string; usb: string } {
  const usb = new Set<string>();
  const pci: string[] = [];
  for (const d of devs) {
    const id = str(d.id).toUpperCase();
    if (id.startsWith("PCI\\")) {
      pci.push(mmLine([str(d.c), str(d.v), str(d.n)]));
      continue;
    }
    const m = id.match(/^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(&MI_)?/);
    if (m && !m[3]) {
      usb.add(
        `Bus 000 Device 000: ID ${m[1]!.toLowerCase()}:${m[2]!.toLowerCase()} ${
          str(d.n)
        }`,
      );
    }
  }
  return { pci: pci.join("\n"), usb: [...usb].join("\n") };
}

/** system_profiler USB JSON (SPUSBDataType or Sonoma+ SPUSBHostDataType;
 *  key names differ) → `lsusb` text: any node with a name + vendor/product
 *  id is a device; buses and hubs without ids are skipped. */
export function macUsb(json: string): string {
  const out = new Set<string>();
  const hex = (v: unknown) =>
    v === "apple_vendor_id" // Apple's own devices carry no hex vendor id
      ? "05ac"
      : typeof v === "number"
      ? v.toString(16).padStart(4, "0")
      : str(v).match(/0x([0-9a-f]{1,4})/i)?.[1]?.toLowerCase().padStart(4, "0");
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Rec;
    const key = (re: RegExp) => Object.keys(o).find((k) => re.test(k));
    const vid = hex(o[key(/vendor_?id$/i) ?? ""]);
    const pid = hex(o[key(/product_?id$/i) ?? ""]);
    if (vid && pid && str(o._name)) {
      out.add(`Bus 000 Device 000: ID ${vid}:${pid} ${str(o._name)}`);
    }
    Object.values(o).forEach(walk);
  };
  walk(parseJson("system_profiler USB", json));
  return [...out].join("\n");
}

export const lsusb = memo(30_000, lsusbUncached);
async function lsusbUncached(): Promise<LsusbEntry[] | null> {
  if (PLATFORM === "linux") {
    const raw = await runCmd(["lsusb"]);
    return call<LsusbEntry[]>("sys_lsusb", [raw]);
  }
  if (PLATFORM === "windows") {
    return call<LsusbEntry[]>("sys_lsusb", [winPnp(await winDevices()).usb]);
  }
  const out = await runCmd([
    "system_profiler",
    "-json",
    "SPUSBDataType",
    "SPUSBHostDataType",
  ], { timeoutMs: 15_000 });
  return call<LsusbEntry[]>("sys_lsusb", [macUsb(out)]);
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
  const speed = (iface: string, link: number, rx: number, tx: number) =>
    JSON.stringify({
      link_max_mbps: link,
      rx_mbps: rx, // raw byte counters — the cell turns them into rates
      tx_mbps: tx,
      iface,
      ts: Date.now(),
    });
  if (PLATFORM === "windows") {
    const st = await winNetState();
    if (!st) return null;
    const n = winNet(st);
    // by index, not name: stdin is not UTF-8, a non-ASCII name would garble
    const [rx = 0, tx = 0] = st.idx
      ? (await pwsh(
        `$s=Get-NetAdapter -InterfaceIndex ${
          Number(st.idx)
        } | Get-NetAdapterStatistics; "$($s.ReceivedBytes) $($s.SentBytes)"`,
      )).split(" ").map((v) => Number(v) || 0)
      : [];
    return call<NetInfo>("sys_net", [
      JSON.stringify(n.addrs),
      n.vpn ? VPN_LINK : "[]",
      n.route,
      n.fw,
      speed(n.iface, n.linkMbps, rx, tx),
    ]);
  }
  // darwin
  const [ifconfig, route, fw] = await Promise.all([
    runCmd(["ifconfig"]),
    runCmd(["route", "-n", "get", "default"]),
    macFirewall(),
  ]);
  const dev = route.match(/interface:\s*(\S+)/)?.[1] ?? "";
  const gw = route.match(/gateway:\s*(\S+)/)?.[1] ?? "";
  const ifaces = macIfaces(ifconfig);
  // system utunN tunnels (iCloud etc.) carry only IPv6 — a VPN has IPv4
  const vpn = ifaces.some((i) =>
    /^(utun|ppp|ipsec)/.test(i.ifname) &&
    i.addr_info.some((a) => a.local?.includes("."))
  );
  const [rx, tx] = dev
    ? macBytes(await runCmd(["netstat", "-ibn", "-I", dev]))
    : [0, 0];
  return call<NetInfo>("sys_net", [
    JSON.stringify(ifaces),
    vpn ? VPN_LINK : "[]",
    gw ? `default via ${gw} dev ${dev}` : "",
    fw,
    speed(dev, ifaces.find((i) => i.ifname === dev)?.link ?? 0, rx, tx),
  ]);
}

// A tunnel the Rust parser recognizes as "VPN up" (Win/OSX detect it host-side)
const VPN_LINK = '[{"ifname":"tun0","operstate":"UP"}]';

// Windows adapters/IPs/route/firewall change rarely — re-read every 10s;
// only the byte counters are read per poll.
export type WinNetState = {
  addrs?: unknown;
  gw?: string;
  dev?: string;
  idx?: number;
  fw?: number;
};
type WinAdapter = {
  ifname?: string;
  operstate?: string;
  desc?: string;
  speed?: string;
  addr_info?: { local?: string } | { local?: string }[];
};
const winNetState = memo(10_000, async () =>
  parseJson<WinNetState>(
    "net",
    await pwsh(
      [
        "$r=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1",
        "$ips=@(Get-NetIPAddress -ErrorAction SilentlyContinue)",
        "$a=@(Get-NetAdapter | ForEach-Object { $i=$_.ifIndex; @{ifname=$_.Name; operstate=$(if ($_.Status -eq 'Up') { 'UP' } else { 'DOWN' }); desc=$_.InterfaceDescription; speed=[string]$_.Speed; addr_info=@($ips | Where-Object InterfaceIndex -eq $i | ForEach-Object { @{local=$_.IPAddress} })} })",
        "ConvertTo-Json -Compress -Depth 5 -InputObject @{addrs=$a; gw=$(if ($r) { $r.NextHop } else { '' }); dev=$(if ($r) { $r.InterfaceAlias } else { '' }); idx=$(if ($r) { $r.ifIndex } else { 0 }); fw=@(Get-NetFirewallProfile | Where-Object Enabled).Count}",
      ].join("; "),
      20_000,
    ), // first call autoloads 3 CDXML modules
  ));

// Full-tunnel VPN clients by adapter description (mesh overlays such as
// Tailscale/ZeroTier don't carry all traffic — not counted, as on Linux).
const VPN_DESC =
  /wireguard|wintun|tap-windows|openvpn|anyconnect|pangp|fortinet|nordlynx|mullvad|\bvpn\b/i;

/** Windows adapter state → the `ip -j -br addr` shape + route/fw strings. */
export function winNet(st: WinNetState) {
  const ad = toArr(st.addrs as WinAdapter | WinAdapter[] | undefined);
  const dev = str(st.dev);
  return {
    addrs: ad.map((a) => ({
      ifname: str(a.ifname),
      operstate: str(a.operstate),
      addr_info: toArr(a.addr_info).map((x) => ({ local: str(x.local) })),
    })),
    vpn: ad.some((a) =>
      a.operstate === "UP" && VPN_DESC.test(`${a.ifname} ${a.desc ?? ""}`)
    ),
    route: st.gw ? `default via ${st.gw} dev ${dev}` : "",
    fw: `defender:${(st.fw ?? 0) > 0 ? "active" : "inactive"}`,
    iface: dev,
    linkMbps: Math.round(
      (Number(ad.find((a) => a.ifname === dev)?.speed) || 0) / 1e6,
    ),
  };
}

/** macOS `ifconfig` → `ip -j -br addr`-shaped interfaces (+ link Mbps from
 *  the wired media line, e.g. "(1000baseT" / "(10Gbase-T"). */
export function macIfaces(ifconfig: string) {
  return ifconfig.split(/\n(?=\S)/).filter(Boolean).map((b) => {
    const m = b.match(/media:.*?\((\d+)(G?)base/);
    return {
      ifname: b.split(":")[0] ?? "",
      operstate: /status: inactive/.test(b) || !/<UP[,>]/.test(b)
        ? "DOWN"
        : "UP",
      addr_info: [...b.matchAll(/\binet6?\s+(\S+)/g)].map((x) => ({
        local: (x[1] ?? "").replace(/%.*$/, ""), // fe80::1%lo0 → fe80::1
      })),
      link: m ? parseInt(m[1] ?? "0") * (m[2] ? 1000 : 1) : 0,
    };
  });
}

/** `netstat -ibn -I <if>` → [rx, tx] bytes from the <Link#> row. Counted
 *  from the right (…Ibytes Opkts Oerrs Obytes Coll): tunnels have no
 *  Address column. */
export function macBytes(netstat: string): [number, number] {
  const c = netstat.split("\n").find((l) => l.includes("<Link#"))?.trim()
    .split(/\s+/) ?? [];
  return c.length >= 7
    ? [Number(c[c.length - 5]) || 0, Number(c[c.length - 2]) || 0]
    : [0, 0];
}

// Application firewall state needs no root (pfctl -s info does).
const macFirewall = memo(10_000, async () => {
  const out = await runCmd([
    "/usr/libexec/ApplicationFirewall/socketfilterfw",
    "--getglobalstate",
  ]);
  return out ? `macOS:${/enabled/i.test(out) ? "active" : "inactive"}` : "none";
});

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

// ── sys: host identity + live vitals (uptime, load, freq, swap) ────────────
// Uptime/swap/load come from Deno (the kernel, no spawn) on every OS; Linux
// adds /proc + cpufreq reads. Best-effort — 0/"" means "unavailable".
export async function sys(): Promise<SysInfo> {
  const mi = Deno.systemMemoryInfo();
  const base: SysInfo = {
    hostname: "",
    kernel: "",
    arch: Deno.build.arch,
    os: PLATFORM,
    os_name: "",
    uptime_s: Deno.osUptime(),
    load1: 0,
    load5: 0,
    load15: 0,
    procs_running: 0,
    procs_total: 0,
    cpu_mhz: 0,
    cpu_max_mhz: 0,
    swap_total_kb: Math.round(mi.swapTotal / 1024),
    swap_used_kb: Math.round(Math.max(0, mi.swapTotal - mi.swapFree) / 1024),
    reboot_required: false,
    governor: "",
  };
  try {
    base.hostname = Deno.hostname();
  } catch (e) {
    warnOnce("hostname", String(e));
  }
  try {
    base.kernel = Deno.osRelease();
  } catch (e) {
    warnOnce("osRelease", String(e));
  }
  // Windows has no load average (Deno reports zeros) — the UI hides it there
  if (PLATFORM !== "windows") {
    [base.load1 = 0, base.load5 = 0, base.load15 = 0] = Deno.loadavg();
  }
  if (PLATFORM !== "linux") {
    const inv = await inventory();
    base.os_name = inv.os_name;
    base.cpu_max_mhz = inv.cpu.max_mhz;
    if (PLATFORM === "windows") {
      base.reboot_required = await winRebootPending();
      [base.swap_total_kb, base.swap_used_kb] = await winSwapKb();
    }
    return base;
  }

  base.os_name = (await osReleaseOnce()).match(/^PRETTY_NAME="?([^"\n]*)/m)
    ?.[1] ?? "";
  // Debian/Ubuntu drop this file when a package (often the kernel) needs a
  // reboot to take effect — a cheap "pending updates" security/health signal.
  for (const p of ["/run/reboot-required", "/var/run/reboot-required"]) {
    try {
      await Deno.stat(p);
      base.reboot_required = true;
      break;
    } catch { /* not present */ }
  }

  const procs = ((await readFile("/proc/loadavg")).trim().split(/\s+/)[3] ?? "")
    .split("/");
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
  return base;
}

const osReleaseOnce = memo(Infinity, () => readFile("/etc/os-release"));

// Deno's Windows swap figures are garbage (CI: total 3087007 B, free 0) —
// read the page files (MB) instead, every 10s.
const winSwapKb = memo(10_000, async (): Promise<[number, number]> => {
  const [total = 0, used = 0] = (await pwsh(
    '$p=@(Get-CimInstance Win32_PageFileUsage); "$([int]($p | Measure-Object AllocatedBaseSize -Sum).Sum) $([int]($p | Measure-Object CurrentUsage -Sum).Sum)"',
  )).split(" ").map((v) => (Number(v) || 0) * 1024);
  return [total, used];
});

// Windows Update parks this key until the pending reboot happens.
const winRebootPending = memo(60_000, async () =>
  (await pwsh(
    "Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'",
  )) === "True");

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
    const j = parseJson<WinSecState>(
      "sec",
      await pwsh(
        [
          "$pn=@{}; Get-Process | ForEach-Object { $pn[[int]$_.Id]=$_.ProcessName }",
          "$t=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{p='tcp'; a=$_.LocalAddress; o=$_.LocalPort; n=[string]$pn[[int]$_.OwningProcess]} })",
          "$u=@(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object { @{p='udp'; a=$_.LocalAddress; o=$_.LocalPort; n=[string]$pn[[int]$_.OwningProcess]} })",
          // registry state is readable without admin (Confirm-SecureBootUEFI is not)
          "$sb=(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State' -ErrorAction SilentlyContinue).UEFISecureBootEnabled",
          // the shell's BitLocker property needs no admin (manage-bde does)
          "$bl=try { (New-Object -ComObject Shell.Application).NameSpace($env:SystemDrive + '\\').Self.ExtendedProperty('System.Volume.BitLockerProtection') } catch { $null }",
          "$av=try { (Get-MpComputerStatus).RealTimeProtectionEnabled } catch { $null }",
          "ConvertTo-Json -Compress -Depth 3 -InputObject @{ports=($t + $u); sb=$sb; bl=$bl; av=$av}",
        ].join("; "),
        20_000,
      ),
    );
    if (!j) return null;
    const w = winSec(j);
    return call<SecInfo>("sys_sec", [w.ss, "", "", "", w.facts]);
  }
  // darwin — lsof for listeners, csrutil (SIP), fdesetup (FileVault)
  const [lsof, sip, fv] = await Promise.all([
    runCmd(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"]),
    runCmd(["csrutil", "status"]),
    runCmd(["fdesetup", "status"]),
  ]);
  const ss = lsof.split("\n").slice(1).map((l) => {
    const c = l.trim().split(/\s+/);
    const addr = c[8] ?? "";
    return c.length > 8 ? `tcp LISTEN 0 0 ${addr} *:* users:(("${c[0]}"))` : "";
  }).filter(Boolean).join("\n");
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
    "crypt FileVault",
  ].join("\n");
  return call<SecInfo>("sys_sec", [ss, "", "", "", facts]);
}

export type WinSecState = {
  ports?: { p?: string; a?: string; o?: number; n?: string }[];
  sb?: number | null;
  bl?: number | null;
  av?: boolean | null;
};

/** Windows listeners + posture → `ss -tulnpH` rows and sys_sec facts.
 *  BitLockerProtection: 1 on · 2 off · 3 encrypting · 4 decrypting ·
 *  5 suspended · 6 locked; anything else (null: no BitLocker) = unknown. */
export function winSec(j: WinSecState): { ss: string; facts: string } {
  const ss = toArr(j.ports).map((p) => {
    const a = str(p.a);
    const n = str(p.n);
    return `${p.p} ${p.p === "tcp" ? "LISTEN" : "UNCONN"} 0 0 ${
      a.includes(":") ? `[${a}]` : a
    }:${p.o} *:*${n ? ` users:(("${n}"))` : ""}`;
  }).join("\n");
  const bl = j.bl ?? -1;
  return {
    ss,
    facts: [
      `secureboot ${
        j.sb === 1 ? "enabled" : j.sb === 0 ? "disabled" : "unknown"
      }`,
      `luks ${[1, 3, 5, 6].includes(bl) ? 1 : [2, 4].includes(bl) ? 0 : -1}`,
      "crypt BitLocker",
      j.av === true ? "av on" : j.av === false ? "av off" : "",
    ].filter(Boolean).join("\n"),
  };
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
