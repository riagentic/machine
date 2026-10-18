// test/machine.test.ts — unit tests for the machine cell logic.
//
// Uses testCell to drive the cell in isolation. The cell's `refresh` method
// calls into the WASM layer, which reads real hardware; in tests we only
// assert the state-shape contract (fields exist, refreshing toggles, no
// throw) — the actual hardware values are environment-dependent.

import { bootCells, testCell } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { machine, netRates } from "../src/wasm.ts";

testCell(machine, "initial state has all panels empty", (t) => {
  const s = t.getState();
  assert(s.refreshing === false, "refreshing should start false");
  assert(
    s.wasmAvailable === true,
    "wasmAvailable defaults true until first refresh",
  );
  assert(s.cpu === null, "cpu starts null");
  assert(s.mem === null, "mem starts null");
  assert(s.lspci.length === 0, "lspci starts empty");
  assert(s.lsusb.length === 0, "lsusb starts empty");
  assert(s.lastRefresh === 0, "lastRefresh starts 0");
});

testCell(machine, "refresh toggles refreshing and never throws", async (t) => {
  // refresh awaits real syscalls; on a box without lspci/lsusb/ip those return
  // "" and the WASM layer returns null — refresh must still clear refreshing.
  await t.send.refresh();
  await t.settle();
  const s = t.getState();
  assert(
    s.refreshing === false,
    "refreshing must be false after refresh resolves",
  );
  assert(
    s.lastRefresh > 0,
    "lastRefresh must be set after a successful refresh",
  );
});

Deno.test("paused skips polls; a forced refresh still samples all", async () => {
  using h = await bootCells([machine]);
  machine.togglePause();
  await machine.refresh();
  await machine.refreshCpu();
  await h.settle();
  assert(machine.lastRefresh === 0, "paused poll must not refresh");
  assert(machine.cpu === null, "paused sampler must not sample");
  await machine.refresh(true);
  await h.settle(); // runs the schedule.next CPU kick
  assert(machine.lastRefresh > 0, "forced refresh runs while paused");
  assert(machine.cpu !== null, "forced refresh also samples CPU");
});

Deno.test("resume kicks an immediate refresh", async () => {
  using h = await bootCells([machine]);
  machine.togglePause();
  machine.togglePause();
  await h.settle();
  assert(machine.paused === false);
  assert(machine.lastRefresh > 0, "resume must refresh at once");
});

testCell(machine, "toggleTheme flips dark ↔ light", async (t) => {
  await t.send.toggleTheme();
  assert(t.getState().theme === "light");
  await t.send.toggleTheme();
  assert(t.getState().theme === "dark");
});

Deno.test("netRates: Mbps from byte deltas; 0 on first/changed iface", () => {
  const a = { iface: "eth0", rx: 0, tx: 0, ts: 0 };
  assertEquals(netRates(null, a), [0, 0]);
  assertEquals(
    netRates(a, { iface: "eth0", rx: 1_250_000, tx: 250_000, ts: 1000 }),
    [10, 2],
  );
  assertEquals(netRates(a, { ...a, iface: "wlan0", rx: 9e9, ts: 1000 }), [
    0,
    0,
  ]);
  assertEquals(netRates(a, { ...a, rx: -5, ts: 1000 }), [0, 0]); // reset
  assertEquals(netRates(a, a), [0, 0]); // no elapsed time
});

testCell(
  machine,
  "setView switches tabs and refuses unknown ids",
  async (t) => {
    await t.send.setView("gpu");
    assert(t.getState().view === "gpu");
    await t.expect.rejects(
      // deno-lint-ignore no-explicit-any
      () => t.send.setView("nope" as any),
      /unknown view/,
    );
    assert(t.getState().view === "gpu", "a refused id leaves the tab as is");
  },
);
