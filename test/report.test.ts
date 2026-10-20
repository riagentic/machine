// test/report.test.ts — unit tests for the pure UI logic: device-string
// cleaning, health/TODO detection, and the copy-to-clipboard report builders.
// These are pure functions of plain data (no DOM, no cell), so they're tested
// directly with representative fixtures — the same shapes the WASM parsers emit.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  cleanHw,
  computeHealth,
  cpuReport,
  diskReport,
  gpuReport,
  groupPorts,
  type HealthInput,
  hwReport,
  hwSpec,
  lspciReport,
  netReport,
  pciIcon,
  type ReportInput,
  secReport,
  secScore,
  shortVendor,
  todoReport,
  usbIcon,
} from "../src/App.tsx";
import type { NetInfo, SecInfo } from "../src/wasm.ts";

// ── device string cleaning ─────────────────────────────────────────────────

Deno.test("cleanHw strips hex id codes and quotes", () => {
  assertEquals(cleanHw(`"Host bridge [0600]"`), "Host bridge");
  assertEquals(cleanHw(`"Device [14d8]"`), "Device");
  assertEquals(
    cleanHw("Advanced Micro Devices, Inc. [AMD] [1022]"),
    "Advanced Micro Devices, Inc. [AMD]",
  );
});

Deno.test("shortVendor extracts the [BRAND] tag, else first token", () => {
  assertEquals(shortVendor("Advanced Micro Devices, Inc. [AMD] [1022]"), "AMD");
  assertEquals(shortVendor("NVIDIA Corporation [10de]"), "NVIDIA");
  assertEquals(
    shortVendor("Realtek Semiconductor Co., Ltd. [10ec]"),
    "Realtek",
  );
  // A bare bracket pair is not a vendor — degrade to the em-dash, never "[]".
  assertEquals(shortVendor("[]"), "—");
  assertEquals(cleanHw("[]"), "");
});

Deno.test("cleanHw strips an empty bracket pair as noise", () => {
  assertEquals(cleanHw(`"[]"`), "");
  assertEquals(cleanHw(`"Device [14d8]"`), "Device");
});

Deno.test("pci/usb icons classify common device kinds", () => {
  assertEquals(pciIcon("VGA compatible controller [0300]"), "gpu");
  assertEquals(pciIcon("Ethernet controller [0200]"), "net");
  assertEquals(pciIcon("Network controller: Wireless 802.11ax"), "wifi");
  assertEquals(pciIcon("Host bridge [0600]"), "chip");
  assertEquals(usbIcon("Dell SK-3205 Keyboard"), "keyboard");
  assertEquals(usbIcon("Linux Foundation 2.0 root hub"), "usb");
});

// ── health / TODO detection ────────────────────────────────────────────────

const empty: HealthInput = {
  cpu: null,
  mem: null,
  disk: null,
  gpu: null,
  net: null,
  sys: null,
  sec: null,
  wasmAvailable: true,
};

Deno.test("computeHealth: nominal system yields no issues", () => {
  assertEquals(computeHealth(empty), []);
});

Deno.test("computeHealth: full disk is a critical issue", () => {
  const issues = computeHealth({
    ...empty,
    disk: {
      root_total_b: 100,
      root_used_b: 96,
      root_used_pct: 96,
      root_avail_b: 4,
      mounts: [{ mount: "/home", total_b: 100, used_b: 96, used_pct: 96 }],
    },
  });
  assertEquals(issues.length, 1);
  assertEquals(issues[0]?.sev, "crit");
  assertStringIncludes(issues[0]?.text ?? "", "/home");
});

Deno.test("computeHealth: inactive firewall is a security issue", () => {
  const issues = computeHealth({
    ...empty,
    net: {
      addrs: [],
      links: [],
      vpn: true,
      firewall: { backend: "none", active: false },
      default_route: "",
      speed: { link_max_mbps: 0, rx_mbps: 0, tx_mbps: 0 },
    },
  });
  assert(issues.some((i) => i.sev === "sec" && /firewall/i.test(i.text)));
});

Deno.test("computeHealth: a hot DIMM is a warning", () => {
  const issues = computeHealth({
    ...empty,
    mem: {
      total_kb: 100,
      available_kb: 60,
      used_kb: 40,
      used_pct: 40,
      temp_c: 84,
    },
  });
  assert(issues.some((i) => i.sev === "warn" && /DIMM/i.test(i.text)));
});

Deno.test("computeHealth ranks critical before warning", () => {
  const issues = computeHealth({
    ...empty,
    mem: {
      total_kb: 100,
      available_kb: 5,
      used_kb: 95,
      used_pct: 95,
      temp_c: 0,
    }, // warn
    disk: {
      root_total_b: 100,
      root_used_b: 95,
      root_used_pct: 95,
      root_avail_b: 5,
      mounts: [{ mount: "/", total_b: 100, used_b: 95, used_pct: 95 }], // crit
    },
  });
  assertEquals(issues[0]?.sev, "crit");
});

// ── security: score, report, health issues ─────────────────────────────────

const netUp: NetInfo = {
  addrs: [],
  links: [],
  vpn: true,
  firewall: { backend: "nftables", active: true },
  default_route: "default via 192.168.1.1",
  speed: { link_max_mbps: 0, rx_mbps: 0, tx_mbps: 0 },
};

const check = (id: string, ok: boolean): SecInfo["checks"][number] => ({
  id,
  label: id,
  value: ok ? "good" : "bad",
  ok,
  hint: `hint for ${id}`,
});

const hardened: SecInfo = {
  ports: [
    {
      proto: "tcp",
      addr: "127.0.0.1",
      port: 631,
      process: "cupsd",
      exposed: false,
    },
  ],
  procs: [],
  checks: [check("aslr", true), check("ssh_root", true)],
};

Deno.test("secScore: hardened box with firewall+vpn scores 100", () => {
  assertEquals(secScore(hardened, netUp), 100);
});

Deno.test("secScore: exposure, threats, and failed checks each cost points", () => {
  const weak: SecInfo = {
    ports: [
      {
        proto: "tcp",
        addr: "0.0.0.0",
        port: 22,
        process: "sshd",
        exposed: true,
      },
      {
        proto: "tcp",
        addr: "0.0.0.0",
        port: 5900,
        process: "vnc",
        exposed: true,
      },
    ],
    procs: [{
      pid: 7,
      user: "bob",
      cmd: "/tmp/x",
      reason: "world-writable dir",
    }],
    checks: [check("aslr", true), check("ssh_root", false)],
  };
  const noNet: NetInfo = {
    ...netUp,
    vpn: false,
    firewall: { backend: "none", active: false },
  };
  // checks 25/50 + ports 12/20 + procs 0/15 + fw 0 + vpn 0
  assertEquals(secScore(weak, noNet), 37);
  assertEquals(secScore(null, netUp), 0);
  // unknown never punishes: zero checks keep the full checks weight
  assertEquals(secScore({ ports: [], procs: [], checks: [] }, netUp), 100);
});

Deno.test("groupPorts collapses per-process floods, exposed first", () => {
  const mk = (port: number, process: string, exposed: boolean) => ({
    proto: "tcp",
    addr: exposed ? "0.0.0.0" : "127.0.0.1",
    port,
    process,
    exposed,
  });
  const groups = groupPorts([
    mk(8000, "validator", false),
    mk(8001, "validator", false),
    mk(8002, "validator", false),
    mk(22, "sshd", true),
    mk(5353, "", true), // no process name → proto label
  ]);
  assertEquals(groups.length, 3);
  // exposed groups lead
  assert(groups[0]?.exposed && groups[1]?.exposed);
  assert(groups.some((g) => g.label === "sshd:22"));
  assert(groups.some((g) => g.label === "tcp:5353"));
  assertEquals(groups.find((g) => !g.exposed)?.label, "validator ×3");
});

Deno.test("secReport lists checks with ✓/✗ and exposure", () => {
  const out = secReport(hardened, netUp);
  assertStringIncludes(out, "## Security");
  assertStringIncludes(out, "Score: 100/100");
  assertStringIncludes(out, "✓ aslr");
  assertStringIncludes(out, "tcp/631 cupsd");
  assertStringIncludes(secReport(null, null), "no data");
});

Deno.test("computeHealth: security posture feeds the TODO list", () => {
  const issues = computeHealth({
    ...empty,
    sec: {
      ports: [
        {
          proto: "tcp",
          addr: "0.0.0.0",
          port: 22,
          process: "sshd",
          exposed: true,
        },
      ],
      procs: [
        { pid: 9, user: "bob", cmd: "/tmp/x", reason: "world-writable dir" },
      ],
      checks: [
        check("ssh_pass", false),
        check("kptr", false),
        check("bpf", false),
      ],
    },
  });
  // suspicious process = crit, ranked first
  assertEquals(issues[0]?.sev, "crit");
  assertStringIncludes(issues[0]?.text ?? "", "Suspicious process 9");
  assert(
    issues.some((i) => i.sev === "sec" && /open to the network/.test(i.text)),
  );
  // loud check (ssh_pass) gets its own line; quiet ones aggregate
  assert(issues.some((i) => /ssh_pass/.test(i.text)));
  assert(issues.some((i) => /2 kernel hardening gaps/.test(i.text)));
});

Deno.test("computeHealth: no swap only warns under memory pressure", () => {
  const sys = {
    hostname: "",
    kernel: "",
    arch: "",
    os: "linux",
    os_name: "",
    uptime_s: 60,
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
  const mem = (used: number) => ({
    total_kb: 100,
    available_kb: 100 - used,
    used_kb: used,
    used_pct: used,
    temp_c: 0,
  });
  assert(
    computeHealth({ ...empty, sys, mem: mem(75) })
      .some((i) => /No swap/.test(i.text)),
  );
  assert(
    !computeHealth({ ...empty, sys, mem: mem(30) })
      .some((i) => /No swap/.test(i.text)),
  );
});

// ── report builders ────────────────────────────────────────────────────────

Deno.test("cpuReport renders a markdown block with the key facts", () => {
  const out = cpuReport(
    {
      model: "AMD Ryzen 9 9950X",
      cores: 32,
      stat: "",
      core_stats: [],
      temp_c: 44,
      util_pct: 16.4,
      cores_util: [],
    },
    null,
  );
  assertStringIncludes(out, "## CPU");
  assertStringIncludes(out, "AMD Ryzen 9 9950X");
  assertStringIncludes(out, "Threads: 32");
});

Deno.test("diskReport free is df Available, not total − used", () => {
  const out = diskReport({
    root_total_b: 100 * 2 ** 30,
    root_used_b: 60 * 2 ** 30,
    root_used_pct: 60,
    root_avail_b: 35 * 2 ** 30, // 5 GiB root-reserved
    mounts: [],
  });
  assertStringIncludes(out, "35.0 GiB free");
});

Deno.test("netReport shows rates without a link cap (Wi-Fi/VPN)", () => {
  const out = netReport({
    ...netUp,
    speed: { link_max_mbps: -1, rx_mbps: 12.5, tx_mbps: 1, iface: "wlan0" },
  });
  assertStringIncludes(out, "Link: ↓12.5 ↑1.0 Mbps");
});

Deno.test("gpuReport labels VRAM in GiB; GPU at crit temp is CRIT", () => {
  const gpu = {
    gpus: [{
      name: "RTX",
      temp_c: 85,
      util_pct: 10,
      mem_total_mb: 8192,
      mem_used_mb: 1024,
    }],
  };
  assertStringIncludes(gpuReport(gpu), "1.0 / 8.0 GiB");
  assert(computeHealth({ ...empty, gpu }).some((i) => i.sev === "crit"));
});

Deno.test("todoReport reports the optimal state when empty", () => {
  assertStringIncludes(todoReport([]), "all systems optimal");
});

Deno.test("lspciReport cleans and lists devices", () => {
  const out = lspciReport([
    {
      class: "Host bridge [0600]",
      vendor: "AMD Inc. [AMD] [1022]",
      name: "Device [14d8]",
    },
  ]);
  assertStringIncludes(out, "Host bridge — AMD");
});

Deno.test("report builders never throw on all-null state", () => {
  const nullState: ReportInput = {
    cpu: null,
    mem: null,
    dimms: [],
    memSlotsTotal: 0,
    board: null,
    gpu: null,
    disk: null,
    net: null,
    sys: null,
    sec: null,
    lspci: [],
    lsusb: [],
  };
  // exercises every builder path via the section reports
  assertStringIncludes(cpuReport(nullState.cpu, nullState.sys), "no data");
  assertStringIncludes(lspciReport(nullState.lspci), "lspci · 0");
});

Deno.test("hwSpec: empty state → no sections, report says no data", () => {
  const empty: ReportInput = {
    cpu: null,
    mem: null,
    dimms: [],
    memSlotsTotal: 0,
    board: null,
    gpu: null,
    disk: null,
    net: null,
    sys: null,
    sec: null,
    lspci: [],
    lsusb: [],
  };
  assertEquals(hwSpec(empty), []);
  assertStringIncludes(hwReport([]), "no data");
});

Deno.test("hwSpec lists static inventory, drops blanks and loopback", () => {
  const spec = hwSpec({
    cpu: {
      model: "AMD Ryzen 9 7950X",
      cores: 32,
      stat: "",
      core_stats: [],
      temp_c: 50,
      util_pct: 10,
      cores_util: [],
    },
    mem: null,
    dimms: [{
      locator: "DIMM_A1",
      size: "32 GB",
      speed: "6000 MT/s",
      type: "DDR5",
    }],
    memSlotsTotal: 4,
    board: null,
    gpu: {
      gpus: [{
        name: "RTX 4090",
        temp_c: 0,
        util_pct: 0,
        mem_total_mb: 24576,
        mem_used_mb: 0,
      }],
    },
    disk: null,
    net: {
      addrs: [{ ifname: "lo" }, { ifname: "eth0" }],
      links: [],
      vpn: false,
      firewall: { backend: "", active: false },
      default_route: "",
      speed: { link_max_mbps: 1000, rx_mbps: 0, tx_mbps: 0 },
    },
    sys: null,
    sec: null,
    lspci: [],
    lsusb: [{
      bus: "001",
      dev: "002",
      id: "046d:c52b",
      name: "Logitech Receiver",
    }],
  });
  assertEquals(spec.map((s) => s.title), [
    "CPU",
    "Memory",
    "GPU",
    "Network",
    "USB · 1",
  ]);
  assertEquals(spec[0]?.rows, [["model", "AMD Ryzen 9 7950X"], [
    "threads",
    "32",
  ]]);
  assertEquals(spec[1]?.rows, [["slots", "1 / 4"], [
    "DIMM_A1",
    "32 GB DDR5 6000 MT/s",
  ]]);
  assertEquals(spec[2]?.rows, [["gpu 0", "RTX 4090 · 24.0 GiB"]]);
  assertEquals(spec[3]?.rows, [["interfaces", "eth0"], [
    "link max",
    "1000 Mbps",
  ]]);
  assertStringIncludes(hwReport(spec), "- 046d:c52b: Logitech Receiver");
});
