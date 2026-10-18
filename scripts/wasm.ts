// scripts/wasm.ts — build the machine-sys Rust crate to WASM and stage it as
// src/syscalls.wasm. Run via `deno task wasm`. Plain extern "C" exports, so
// cargo's .wasm IS the artifact (no wasm-bindgen step).

import { fromFileUrl } from "@std/path";

const rustDir = fromFileUrl(new URL("../rust/", import.meta.url));
const artifact =
  `${rustDir}target/wasm32-unknown-unknown/release/machine_sys.wasm`;
const appWasm = fromFileUrl(new URL("../src/syscalls.wasm", import.meta.url));

console.log("→ cargo build --release --target wasm32-unknown-unknown");
const { success } = await new Deno.Command("cargo", {
  args: ["build", "--release", "--target", "wasm32-unknown-unknown"],
  cwd: rustDir,
}).spawn().status;
if (!success) throw new Error("cargo build failed (see output above)");

await Deno.copyFile(artifact, appWasm);
const { size } = await Deno.stat(appWasm);
console.log(`✓ ${appWasm} (${(size / 1024).toFixed(1)} KiB)`);
