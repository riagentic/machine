// test/cell.test.ts — unit tests for the machine cell logic.
//
// Uses testCell to drive the cell in isolation. The cell's `refresh` method
// calls into the WASM layer, which reads real hardware; in tests we only
// assert the state-shape contract (fields exist, refreshing toggles, no
// throw) — the actual hardware values are environment-dependent.

import { testCell } from "aio/testing";
import { assert } from "@std/assert";
import { machine } from "../src/wasm.ts";

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
