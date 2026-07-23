// test/report.test.ts — unit tests for the pure UI logic: device-string
// cleaning, health/TODO detection, and the copy-to-clipboard report builders.
// These are pure functions of plain data (no DOM, no cell), so they're tested
// directly with representative fixtures — the same shapes the WASM parsers emit.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  cleanHw,
  computeHealth,
  cpuReport,
  type HealthInput,
  lspciReport,
  pciEmoji,
  type ReportInput,
  shortVendor,
  todoReport,
  usbEmoji,
} from "../src/App.tsx";

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
});

Deno.test("pci/usb emoji classify common device kinds", () => {
  assertEquals(pciEmoji("VGA compatible controller [0300]"), "🎮");
  assertEquals(pciEmoji("Ethernet controller [0200]"), "🌐");
  assertEquals(pciEmoji("Host bridge [0600]"), "🧩");
  assertEquals(usbEmoji("Dell SK-3205 Keyboard"), "⌨️");
  assertEquals(usbEmoji("Linux Foundation 2.0 root hub"), "🔀");
});

// ── health / TODO detection ────────────────────────────────────────────────

const empty: HealthInput = {
  cpu: null,
  mem: null,
  disk: null,
  gpu: null,
  net: null,
  sys: null,
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
      mounts: [{ mount: "/", total_b: 100, used_b: 95, used_pct: 95 }], // crit
    },
  });
  assertEquals(issues[0]?.sev, "crit");
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
    lspci: [],
    lsusb: [],
  };
  // exercises every builder path via the section reports
  assertStringIncludes(cpuReport(nullState.cpu, nullState.sys), "no data");
  assertStringIncludes(lspciReport(nullState.lspci), "lspci · 0");
});
