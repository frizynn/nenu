import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findClaudeExecutable } from "./claude-sessions.ts";

test("Claude discovery works with launchd's system-only PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "nenu-claude-home-"));
  try {
    await mkdir(join(home, ".local/bin"), { recursive: true });
    const executable = join(home, ".local/bin/claude");
    await writeFile(executable, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
    expect(findClaudeExecutable("/usr/bin:/bin", home)).toBe(executable);
  } finally { await rm(home, { recursive: true, force: true }); }
});
