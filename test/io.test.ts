import { assertEquals } from "@std/assert";
import { runCmd, sshdConfig } from "../src/io.server.ts";

Deno.test("runCmd: SIGKILLs a SIGTERM-ignoring child on timeout", async () => {
  const t0 = Date.now();
  const out = await runCmd(["sh", "-c", "trap '' TERM; sleep 5; echo late"], {
    timeoutMs: 200,
  });
  assertEquals(out, "");
  assertEquals(Date.now() - t0 < 2000, true);
  await new Promise((r) => setTimeout(r, 100)); // let the killed child reap
});

Deno.test("runCmd: missing binary resolves empty", async () => {
  assertEquals(await runCmd(["machine-no-such-binary"]), "");
});

Deno.test("sshdConfig: inlines sorted Include matches at their position", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/d`);
  await Deno.writeTextFile(`${dir}/d/20-b.conf`, "PermitRootLogin yes");
  await Deno.writeTextFile(`${dir}/d/10-a.conf`, "PasswordAuthentication no");
  await Deno.writeTextFile(`${dir}/d/skip.txt`, "PermitRootLogin no");
  await Deno.writeTextFile(
    `${dir}/main`,
    `Include ${dir}/d/*.conf\nPermitRootLogin no`,
  );
  try {
    assertEquals(
      await sshdConfig(`${dir}/main`),
      "PasswordAuthentication no\nPermitRootLogin yes\nPermitRootLogin no",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
