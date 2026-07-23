// rust/build.ts — compile the machine-sys Rust crate to WASM and stage it for
// the aio app. Run via `deno task wasm`.
//
// Produces rust/pkg/machine_sys_bg.wasm (from wasm-bindgen-style path) — but we
// use plain extern "C" exports, so the cargo artifact is the raw .wasm we copy
// directly to src/syscalls.wasm.

import { dirname, fromFileUrl, join } from "jsr:@std/path@^1";

async function run(cmd: string[], opts?: { cwd?: string }) {
  const bin = cmd[0];
  if (!bin) throw new Error("run(): empty command");
  const p = new Deno.Command(bin, {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    cwd: opts?.cwd,
  });
  const out = await p.output();
  const stderr = new TextDecoder().decode(out.stderr);
  const stdout = new TextDecoder().decode(out.stdout);
  if (!out.success) {
    console.error(stderr || stdout);
    throw new Error(`command failed: ${cmd.join(" ")}`);
  }
  if (stdout.trim()) console.log(stdout);
  if (stderr.trim()) console.error(stderr);
}

async function main() {
  // build.ts lives in rust/, so root is one level up.
  const here = dirname(fromFileUrl(import.meta.url));
  const root = join(here, "..");
  const rustDir = here;
  const cargoTarget = join(rustDir, "target");
  const wasmArtifact = join(
    cargoTarget,
    "wasm32-unknown-unknown",
    "release",
    "machine_sys.wasm",
  );
  const pkgDir = join(rustDir, "pkg");
  const stagedWasm = join(pkgDir, "machine_sys.wasm");
  const appWasm = join(root, "src", "syscalls.wasm");

  console.log("→ cargo build --release (wasm32-unknown-unknown)");
  await run(
    ["cargo", "build", "--release", "--target", "wasm32-unknown-unknown"],
    { cwd: rustDir },
  );

  await Deno.mkdir(pkgDir, { recursive: true });
  await Deno.mkdir(join(root, "src"), { recursive: true });
  await Deno.copyFile(wasmArtifact, stagedWasm);
  await Deno.copyFile(stagedWasm, appWasm);
  const stat = await Deno.stat(appWasm);
  console.log(`✓ staged ${stagedWasm}`);
  console.log(`✓ copied to ${appWasm} (${(stat.size / 1024).toFixed(1)} KiB)`);
}

if (import.meta.main) {
  await main();
}
