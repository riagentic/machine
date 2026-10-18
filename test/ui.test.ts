// test/ui.test.ts — functional UI tests proving the app is usable by a user.
//
// Uses the aio semantic testUI harness: no selectors, no sleeps. Actions queue
// without await; we await only observations (expectCell, waitFor, settle).
// Component/element names are LABEL+ROLE from the TSX.
//
// These tests prove the kata's usability invariants: the header is visible,
// the refresh button is clickable, the panels render (even in degraded
// state), and the app never throws on a fresh boot.

import { testUI } from "aio/testing";
import { assert, assertExists } from "@std/assert";
import { machine } from "../src/wasm.ts";
import App from "../src/App.tsx";

testUI(App, "boots with header, brand, and refresh button", async (ui) => {
  await ui.settle();
  const surface = ui.surface();
  const text = surface.text ?? "";
  assert(
    text.includes("machine"),
    `header should show app name; got: ${text.slice(0, 200)}`,
  );
  // The refresh button is addressable as RefreshButton (the ↻ button).
  assertExists(ui.App.RefreshButton, "RefreshButton should be on the surface");
});

testUI(
  App,
  "refresh button click dispatches refresh and stays responsive",
  async (ui) => {
    // Click queues a dispatch; we then observe the cell state settled. The
    // refresh method runs real async I/O (file reads, df/lspci/lsusb/ip)
    // which can take ~300ms, so poll with waitFor rather than one-shot
    // expectCell.
    ui.App.RefreshButton.click();
    await ui.waitFor(() => machine.lastRefresh > 0, { timeoutMs: 5000 });
    // App is still responsive: the button is still on the surface.
    assertExists(
      ui.App.RefreshButton,
      "RefreshButton still present after refresh",
    );
  },
);

testUI(App, "panels render all hardware sections", async (ui) => {
  await ui.settle();
  // Assert against the full rendered DOM, not `surface().text` — the semantic
  // surface's root `text` is a capped ~160-char preview (see aio ui-surface),
  // which can't hold all eight panel titles once each panel carries an emoji +
  // live vitals. `ui.html()` is the harness's own "for assertions" root HTML.
  const html = ui.html();
  for (
    const title of [
      "CPU",
      "MEMORY",
      "MOTHERBOARD",
      "GPU",
      "DISK",
      "SECURITY",
      "NETWORK",
      "LSPCI",
      "LSUSB",
    ]
  ) {
    assert(
      html.includes(title),
      `panel "${title}" should render; html: ${html.slice(0, 400)}`,
    );
  }
});

// Regression: the 2s full refresh and the 1s CPU sampler share the prev*
// scratch state. Under transactional methods, concurrent runs used to abort on
// TX_CONFLICT, leaving the whole deck empty. Both must commit cleanly now (the
// shared accumulators are routed through s.$live, exempt from conflict checks).
testUI(
  App,
  "concurrent refresh and refreshCpu both commit without conflict",
  async (ui) => {
    // Wait out the boot refresh so the baseline below is stable.
    await ui.waitFor(() => !machine.refreshing, { timeoutMs: 8000 });
    const before = machine.lastRefresh;
    // Fire both without awaiting — overlapping, as the two schedules do live.
    // Forced: a paused cell would otherwise skip the full refresh.
    machine.refresh(true);
    machine.refreshCpu();
    // lastRefresh ADVANCING proves this refresh committed rather than being
    // discarded (boot alone can't satisfy it).
    await ui.waitFor(() => machine.lastRefresh > before, { timeoutMs: 8000 });
    assertExists(
      ui.App.RefreshButton,
      "app still responsive after overlapping refresh + sampler",
    );
  },
);

// Both themes render every panel; contrast is audited by the harness on
// render (any "[aio-dev] … unreadable" warning fails this test).
testUI(App, "theme toggle renders both palettes cleanly", async (ui) => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
    orig(...a);
  };
  try {
    await ui.settle();
    const start = machine.theme;
    ui.App.ThemeButton.click();
    await ui.waitFor(() => machine.theme !== start, { timeoutMs: 3000 });
    await ui.settle();
    assert(ui.html().includes(`data-theme="${machine.theme}"`));
    ui.App.ThemeButton.click();
    await ui.waitFor(() => machine.theme === start, { timeoutMs: 3000 });
    await ui.settle();
  } finally {
    console.warn = orig;
  }
  const bad = warns.filter((w) => w.includes("unreadable"));
  assert(bad.length === 0, `contrast warnings:\n${bad.join("\n")}`);
});

testUI(App, "left tabs show one card; All shows every card", async (ui) => {
  await ui.settle();
  ui.App.CPUTabButton.click();
  await ui.waitFor(() => machine.view === "cpu", { timeoutMs: 3000 });
  await ui.settle();
  const one = ui.html();
  assert(one.includes("CPU") && !one.includes("MOTHERBOARD"), "only CPU card");
  ui.App.AllTabButton.click();
  await ui.waitFor(() => machine.view === "all", { timeoutMs: 3000 });
  await ui.settle();
  const all = ui.html();
  assert(all.includes("MOTHERBOARD") && all.includes("LSUSB"), "all cards");
});
