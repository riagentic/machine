// src/app.ts — machine entry point.
//
// Boots the aio app with the single `machine` cell and a static poll schedule.
// The schedule fires `machine.refresh` every 2s — a pure effect dispatched by
// the runtime, never on the UI render loop. Heavy I/O (file reads, df/lspci/
// lsusb/ip) happens inside the cell method, off the main render path, so the
// window stays responsive even on a loaded machine (kata: "app is not freezing
// or blocking underlying PC/OS").

import { aio } from "aio";
import { machine } from "./wasm.ts";

await aio.run({
  appId: "machine",
  appVersion: "0.1.0",
  cells: [machine],
  persist: false, // hardware state is live, not persisted
  // Hardware reads (lspci/lsusb/df/ip) are inherently I/O-bound (50-300ms).
  // They run async off the reduce loop; the default 5ms effect budget is
  // tuned for sync CPU-bound effects. Raise both the budget and the slow-
  // effect warning threshold so the legitimate async refresh doesn't log a
  // spurious violation on every 2s poll — the UI stays responsive because
  // the work is awaited in parallel, not blocking render.
  effectTimeoutMs: 5000,
  perfBudget: { reduce: 100, effect: 500 },
  ui: {
    title: "machine",
    width: 460,
    height: 820,
    showStatus: false,
  },
  schedules: [
    { id: "machine.poll", every: 2000, action: machine.refresh.action() },
    // kata: CPU line chart shows history per second — light CPU-only sampler
    { id: "machine.cpu", every: 1000, action: machine.refreshCpu.action() },
  ],
  onStart: () => {
    // kick the first refresh immediately so the UI isn't empty for 2s
    machine.refresh();
  },
});
