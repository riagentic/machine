// scripts/wasm.ts — build the machine-sys Rust crate to WASM and stage it as
// src/syscalls.wasm. Run via `deno task wasm`. Plain extern "C" exports, so
// cargo's .wasm IS the artifact (no wasm-bindgen step).
//
// src/syscalls.wasm is committed (WASM is platform-independent), so a machine
// without Rust + the wasm32 target keeps the committed build instead of failing.
// After changing rust/, rebuild with Rust installed and commit the new wasm.

import { fromFileUrl } from "@std/path";

const rustDir = fromFileUrl(new URL("../rust/", import.meta.url));
const artifact =
  `${rustDir}target/wasm32-unknown-unknown/release/machine_sys.wasm`;
const appWasm = fromFileUrl(new URL("../src/syscalls.wasm", import.meta.url));

const committed = async (): Promise<number | null> => {
  try {
    return (await Deno.stat(appWasm)).size;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
};

const keepCommitted = async (why: string): Promise<never> => {
  const size = await committed();
  if (size === null) {
    throw new Error(`${why}, and no committed ${appWasm} to fall back to`);
  }
  console.warn(
    `⚠ ${why} — using committed ${appWasm} (${(size / 1024).toFixed(1)} KiB)`,
  );
  Deno.exit(0);
};

console.log("→ cargo build --release --target wasm32-unknown-unknown");
let success: boolean;
try {
  ({ success } = await new Deno.Command("cargo", {
    args: ["build", "--release", "--target", "wasm32-unknown-unknown"],
    cwd: rustDir,
  }).spawn().status);
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
  await keepCommitted("cargo not found on PATH");
}
if (!success!) {
  await keepCommitted(
    "cargo build failed (see output above; needs `rustup target add wasm32-unknown-unknown`)",
  );
}

await Deno.copyFile(artifact, appWasm);
const { size } = await Deno.stat(appWasm);
console.log(`✓ ${appWasm} (${(size / 1024).toFixed(1)} KiB)`);
