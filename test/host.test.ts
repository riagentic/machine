// test/host.test.ts — the Win/OSX host mappers (pure: OS command/JSON output
// → the text/shapes the Rust parsers and panels read), plus a live smoke test
// of the real host. CI runs this file on Linux, Windows and macOS, so the
// live test is what proves each OS path end to end.

import { assert, assertEquals } from "@std/assert";
import * as io from "../src/io.server.ts";

Deno.test("procStat: aggregate first, then cpuN; idle is field 4", () => {
  assertEquals(
    io.procStat([{ user: 1, sys: 2, idle: 3 }, {
      user: 10,
      sys: 20,
      idle: 30,
    }]),
    "cpu  11 0 22 33\ncpu0 1 0 2 3\ncpu1 10 0 20 30",
  );
  assertEquals(io.procStat([]), "");
});

Deno.test("toArr: PowerShell's flattened/null lists become arrays", () => {
  assertEquals(io.toArr(null), []);
  assertEquals(io.toArr({ a: 1 }), [{ a: 1 }]);
  assertEquals(io.toArr([1, 2]), [1, 2]);
});

Deno.test("winInventory maps CIM fields; one-DIMM list survives flattening", () => {
  const inv = io.winInventory({
    cpu: "AMD Ryzen 7 5800X 8-Core Processor ",
    threads: 16,
    mhz: 3801,
    bn: "B550 AORUS ELITE",
    bv: "Gigabyte Technology Co., Ltd.",
    bver: "x.x",
    biv: "American Megatrends International, LLC.",
    bivr: "F15",
    bd: "2021-08-23",
    model: "B550 AORUS ELITE",
    os: "Microsoft Windows 11 Pro",
    slots: 4,
    mem: { l: "DIMM 1", c: "17179869184", s: 3200, t: 26 } as never,
    gpu: [{ n: "AMD Radeon RX 6800", r: "17163091968" }],
  });
  assertEquals(inv.cpu, {
    model: "AMD Ryzen 7 5800X 8-Core Processor",
    threads: 16,
    max_mhz: 3801,
  });
  assertEquals(inv.board[0], "B550 AORUS ELITE");
  assertEquals(inv.board[5], "2021-08-23");
  assertEquals(inv.dimms, {
    list: [{
      locator: "DIMM 1",
      size: "16 GB",
      speed: "3200 MT/s",
      type: "DDR4",
    }],
    slots_total: 4,
  });
  assertEquals(inv.gpus, [{ name: "AMD Radeon RX 6800", vram_mb: 16368 }]);
  assertEquals(inv.os_name, "Microsoft Windows 11 Pro");
});

Deno.test("macInventory: Apple Silicon (unified memory, no Intel keys)", () => {
  const inv = io.macInventory(
    "machdep.cpu.brand_string: Apple M2 Pro\nhw.logicalcpu: 10\n",
    JSON.stringify({
      SPHardwareDataType: [{
        boot_rom_version: "10151.41.12",
        chip_type: "Apple M2 Pro",
        machine_model: "Mac14,9",
        machine_name: "MacBook Pro",
      }],
      SPMemoryDataType: [{ dimm_type: "LPDDR5", SPMemoryDataType: "16 GB" }],
      SPDisplaysDataType: [{
        _name: "kHW_AppleM2ProItem",
        sppci_model: "Apple M2 Pro",
      }],
    }),
    "ProductName:\t\tmacOS\nProductVersion:\t\t15.1\nBuildVersion:\t\t24B83\n",
  );
  assertEquals(inv.cpu, { model: "Apple M2 Pro", threads: 10, max_mhz: 0 });
  assertEquals(inv.board, [
    "Mac14,9",
    "Apple",
    "",
    "Apple",
    "10151.41.12",
    "",
    "MacBook Pro",
  ]);
  assertEquals(inv.dimms, {
    list: [{ locator: "unified", size: "16 GB", speed: "", type: "LPDDR5" }],
    slots_total: 0,
  });
  assertEquals(inv.gpus, [{ name: "Apple M2 Pro", vram_mb: 0 }]);
  assertEquals(inv.os_name, "macOS 15.1");
});

Deno.test("macInventory: Intel slots (empty ones count, aren't listed)", () => {
  const inv = io.macInventory(
    "machdep.cpu.brand_string: Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz\nhw.logicalcpu: 12\nhw.cpufrequency_max: 3200000000\n",
    JSON.stringify({
      SPMemoryDataType: [{
        _items: [
          {
            _name: "BANK 0/ChannelA-DIMM0",
            dimm_size: "8 GB",
            dimm_speed: "2667 MHz",
            dimm_type: "DDR4",
          },
          {
            _name: "BANK 1/ChannelB-DIMM0",
            dimm_size: "empty",
            dimm_speed: "empty",
            dimm_type: "empty",
          },
        ],
      }],
      SPDisplaysDataType: [{
        sppci_model: "Radeon Pro 560X",
        spdisplays_vram: "4 GB",
      }],
    }),
    "",
  );
  assertEquals(inv.cpu.max_mhz, 3200);
  assertEquals(inv.dimms.slots_total, 2);
  assertEquals(inv.dimms.list.map((d) => d.locator), ["BANK 0/ChannelA-DIMM0"]);
  assertEquals(inv.gpus, [{ name: "Radeon Pro 560X", vram_mb: 4096 }]);
});

Deno.test("winPnp: PCI rows, USB VID:PID, interface children collapse", () => {
  const out = io.winPnp([
    {
      id: "PCI\\VEN_10DE&DEV_2684&SUBSYS_0",
      c: "Display",
      v: "NVIDIA",
      n: "NVIDIA GeForce RTX 4090",
    },
    {
      id: "USB\\VID_046D&PID_C52B\\5&2B3C",
      c: "USB",
      v: "Logitech",
      n: "Logitech USB Receiver",
    },
    {
      id: "USB\\VID_046D&PID_C52B&MI_00\\6&1",
      c: "HIDClass",
      v: "(Standard)",
      n: "USB Input Device",
    },
    {
      id: "USB\\ROOT_HUB30\\4&1",
      c: "USB",
      v: "(Standard)",
      n: "USB Root Hub (USB 3.0)",
    },
  ]);
  assertEquals(out.pci, `- "Display" "NVIDIA" "NVIDIA GeForce RTX 4090"`);
  assertEquals(
    out.usb,
    "Bus 000 Device 000: ID 046d:c52b Logitech USB Receiver",
  );
});

Deno.test("macUsb: walks nested items; buses/hubs without ids skipped", () => {
  const out = io.macUsb(JSON.stringify({
    SPUSBDataType: [{
      _name: "USB31Bus",
      _items: [{
        _name: "USB3.1 Hub",
        _items: [{
          _name: "Magic Keyboard",
          vendor_id: "0x05ac  (Apple Inc.)",
          product_id: "0x029c",
        }],
      }],
    }],
    SPUSBHostDataType: [{
      _name: "Mouse",
      USBDeviceKeyVendorID: 1133,
      USBDeviceKeyProductID: 49298,
    }],
  }));
  assertEquals(
    out,
    "Bus 000 Device 000: ID 05ac:029c Magic Keyboard\nBus 000 Device 000: ID 046d:c092 Mouse",
  );
});

Deno.test("winNet: flattened adapter → ip shape, route, VPN by description", () => {
  const n = io.winNet({
    addrs: {
      ifname: "Ethernet",
      operstate: "UP",
      desc: "Intel(R) Ethernet Controller I225-V",
      speed: "2500000000",
      addr_info: { local: "10.0.0.4" },
    },
    gw: "10.0.0.1",
    dev: "Ethernet",
    fw: 3,
  });
  assertEquals(n.addrs, [{
    ifname: "Ethernet",
    operstate: "UP",
    addr_info: [{ local: "10.0.0.4" }],
  }]);
  assertEquals(n.route, "default via 10.0.0.1 dev Ethernet");
  assertEquals(n.fw, "defender:active");
  assertEquals(n.linkMbps, 2500);
  assertEquals(n.vpn, false);
  const vpn = io.winNet({
    addrs: [{ ifname: "wg0", operstate: "UP", desc: "WireGuard Tunnel" }],
    fw: 0,
  });
  assertEquals([vpn.vpn, vpn.fw, vpn.route], [true, "defender:inactive", ""]);
});

Deno.test("macIfaces / macBytes: ifconfig + netstat -ibn", () => {
  const ifs = io.macIfaces(
    "lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n\tinet 127.0.0.1 netmask 0xff000000\n\tinet6 fe80::1%lo0 prefixlen 64\n" +
      "en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tinet 10.0.0.9 netmask 0xffffff00\n\tmedia: autoselect (1000baseT <full-duplex>)\n\tstatus: active\n" +
      "en1: flags=8863<UP,BROADCAST> mtu 1500\n\tstatus: inactive\n",
  );
  assertEquals(ifs.map((i) => [i.ifname, i.operstate, i.link]), [
    ["lo0", "UP", 0],
    ["en0", "UP", 1000],
    ["en1", "DOWN", 0],
  ]);
  assertEquals(ifs[0]?.addr_info, [{ local: "127.0.0.1" }, {
    local: "fe80::1",
  }]);
  assertEquals(
    io.macBytes(
      "Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\n" +
        "en0   1500  <Link#6>    aa:bb:cc:dd:ee:ff  100     0     5000    200     0     7000     0\n" +
        "en0   1500  10.0.0/24     10.0.0.9           100     -     5000    200     -     7000     -\n",
    ),
    [5000, 7000],
  );
  assertEquals(io.macBytes(""), [0, 0]);
});

Deno.test("macDf: bytes, APFS Data volume reported as /, system volumes dropped", () => {
  const out = io.macDf(
    "Filesystem     1024-blocks      Used Available Capacity  Mounted on\n" +
      "/dev/disk3s1s1   482797652  10000000 300000000     4%    /\n" +
      "/dev/disk3s6     482797652   2097152 300000000     1%    /System/Volumes/VM\n" +
      "/dev/disk3s5     482797652 170000000 300000000    37%    /System/Volumes/Data\n" +
      "/dev/disk4s1      61000000  30000000  31000000    50%    /Volumes/USB Stick\n",
  );
  assertEquals(out.split("\n"), [
    `/dev/disk3s5 ${482797652 * 1024} ${170000000 * 1024} ${
      300000000 * 1024
    } 37% /`,
    `/dev/disk4s1 ${61000000 * 1024} ${30000000 * 1024} ${
      31000000 * 1024
    } 50% /Volumes/USB Stick`,
  ]);
});

Deno.test("winSec: ss rows (IPv6 bracketed, process names) + posture facts", () => {
  const w = io.winSec({
    ports: [
      { p: "tcp", a: "0.0.0.0", o: 135, n: "svchost" },
      { p: "tcp", a: "::", o: 445, n: "System" },
      { p: "udp", a: "127.0.0.1", o: 1900, n: "" },
    ],
    sb: 1,
    bl: 2,
    av: true,
  });
  assertEquals(w.ss.split("\n"), [
    `tcp LISTEN 0 0 0.0.0.0:135 *:* users:(("svchost"))`,
    `tcp LISTEN 0 0 [::]:445 *:* users:(("System"))`,
    "udp UNCONN 0 0 127.0.0.1:1900 *:*",
  ]);
  assertEquals(w.facts, "secureboot enabled\nluks 0\ncrypt BitLocker\nav on");
  assertEquals(
    io.winSec({ sb: null, bl: null, av: null }).facts,
    "secureboot unknown\nluks -1\ncrypt BitLocker",
  );
});

// ── live host (whatever OS runs the tests) ─────────────────────────────────

const ticks = (stat: string) =>
  stat.split(/\s+/).slice(1).reduce((a, n) => a + (Number(n) || 0), 0);

Deno.test(`live ${io.PLATFORM} host: every panel reads real data`, async () => {
  try {
    await Deno.stat(new URL("../src/syscalls.wasm", import.meta.url));
  } catch {
    throw new Error("src/syscalls.wasm missing — run `deno task wasm` first");
  }
  try {
    const c1 = await io.cpu();
    await new Promise((r) => setTimeout(r, 300));
    const c2 = await io.cpu();
    assert(c1 && c2, "cpu");
    assert(c2.model, "cpu model");
    assert(c2.cores > 0, "cpu threads");
    assertEquals(c2.core_stats.length, c2.cores, "one tick line per thread");
    assert(ticks(c2.stat) > ticks(c1.stat), "CPU tick counters advance");

    const snap = await io.collectAll();
    assert(snap.wasmAvailable, "wasm loaded");
    assert(snap.mem && snap.mem.total_kb > 0, "memory total");
    assert(
      snap.mem.used_pct > 0 && snap.mem.used_pct < 100,
      `memory used %: ${JSON.stringify(snap.mem)} from ${
        JSON.stringify(Deno.systemMemoryInfo())
      }`,
    );
    assert(snap.disk && snap.disk.root_total_b > 0, "root/system drive size");
    assert(snap.board, "board");
    assert(snap.gpu, "gpu (list may be empty)");
    assert(snap.sec, "security");
    assert(snap.sys && snap.sys.uptime_s > 0, "uptime");
    assert(snap.sys.hostname, "hostname");
    assert(snap.sys.os_name, "OS name");
    assert(
      snap.sys.swap_used_kb >= 0 &&
        snap.sys.swap_used_kb <= snap.sys.swap_total_kb,
      `swap: ${snap.sys.swap_used_kb} / ${snap.sys.swap_total_kb} kB`,
    );
    const addrs = snap.net?.addrs;
    assert(Array.isArray(addrs) && addrs.length > 0, "network interfaces");
    for (const a of addrs as { ifname?: unknown }[]) {
      assert(typeof a.ifname === "string" && a.ifname, "interface name");
    }
  } finally {
    await io.closeHost();
  }
});
