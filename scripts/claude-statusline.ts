import { recordClaudeStatusline } from "../bridge/claude-telemetry.ts";

if (import.meta.main) {
  const stateDir = process.argv[2];
  const original = process.argv[3];
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    size += chunk.length;
    if (size > 1024 * 1024) process.exit(0);
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  try {
    if (stateDir)
      await recordClaudeStatusline(
        JSON.parse(input.toString("utf8")),
        stateDir,
      );
  } catch {
    /* A metrics failure must not replace the user's status line. */
  }
  if (original) {
    const child = Bun.spawn(["/bin/sh", "-c", original], {
      stdin: input,
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    process.exit(await child.exited);
  }
}
