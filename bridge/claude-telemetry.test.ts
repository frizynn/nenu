import { expect, test } from "bun:test";
import { decodeClaudeStatusline } from "./claude-telemetry.ts";
import { mkdtemp, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordClaudeStatusline, ClaudeTelemetry } from "./claude-telemetry.ts";
import { claudeStatuslineSettings } from "../scripts/install-claude-statusline.ts";
import type { AgentView } from "./types.ts";

test("native Claude reports exact context and both quota windows without inferred capacity", () => {
  const value = decodeClaudeStatusline(
    {
      session_id: "e6cb30b2-d716-43a3-96b7-0a475f28c9b6",
      model: { id: "claude-opus-5-5" },
      context_window: {
        context_window_size: 1000000,
        used_percentage: 40,
        total_input_tokens: 123,
        total_output_tokens: 45,
        current_usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 395000,
          cache_creation_input_tokens: 1000,
        },
      },
      rate_limits: {
        five_hour: { used_percentage: 8, resets_at: 1790500000 },
        seven_day: { used_percentage: 19, resets_at: 1790800000 },
      },
    },
    1790400000000,
  );
  expect(value?.telemetry).toMatchObject({
    source: "statusline",
    model: "claude-opus-5-5",
    context: { usedTokens: 397000, windowTokens: 1000000, usedPercent: 40 },
    rateLimits: [
      {
        name: "primary",
        usedPercent: 8,
        windowMinutes: 300,
        resetsAt: 1790500000,
      },
      { name: "secondary", usedPercent: 19, windowMinutes: 10080 },
    ],
  });
  expect(
    decodeClaudeStatusline({ session_id: "../../private" }),
  ).toBeUndefined();
});

test("missing, null and invalid native values stay unavailable", () => {
  const value = decodeClaudeStatusline({
    session_id: "e6cb30b2-d716-43a3-96b7-0a475f28c9b6",
    context_window: { used_percentage: null, context_window_size: -1 },
    rate_limits: {
      five_hour: { used_percentage: 101 },
      seven_day: { used_percentage: null },
    },
  });
  expect(value?.telemetry.context).toBeUndefined();
  expect(value?.telemetry.rateLimits).toBeUndefined();
});

const sessionId = "e6cb30b2-d716-43a3-96b7-0a475f28c9b6";
const native = {
  session_id: sessionId,
  model: { id: "claude-opus-5-5" },
  context_window: { used_percentage: 40 },
  rate_limits: { five_hour: { used_percentage: 8 } },
  secret: "must not persist",
  transcript_path: "/private/transcript",
};
const pane = {
  agent: "claude",
  agentSession: { kind: "id", value: sessionId },
} as AgentView;

test("capture stores only telemetry and serves only the matching Claude session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-status-"));
  try {
    await recordClaudeStatusline(native, dir);
    const stored = await readFile(
      join(dir, "claude-status", `${sessionId}.json`),
      "utf8",
    );
    expect(stored).not.toContain("private");
    expect(stored).not.toContain("secret");
    const reader = new ClaudeTelemetry(dir);
    expect((await reader.read(pane))?.telemetry.context?.usedPercent).toBe(40);
    expect(await reader.read({ ...pane, agent: "codex" })).toBeUndefined();
    expect(
      await reader.read({
        ...pane,
        agentSession: {
          kind: "id",
          value: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
      }),
    ).toBeUndefined();
    await rm(join(dir, "claude-status", `${sessionId}.json`));
    await symlink(
      "/etc/passwd",
      join(dir, "claude-status", `${sessionId}.json`),
    );
    expect(await reader.read(pane)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture refuses a symlinked status directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-status-"));
  try {
    await mkdir(join(dir, "elsewhere"));
    await symlink(join(dir, "elsewhere"), join(dir, "claude-status"));
    await expect(recordClaudeStatusline(native, dir)).rejects.toThrow(
      "Invalid status directory",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installer keeps status line options and hooks; wrapper preserves stdin and output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-status-"));
  try {
    const original = {
      statusLine: { type: "command", command: "cat", padding: 2 },
      hooks: { Stop: [] },
    };
    const script = join(import.meta.dir, "../scripts/claude-statusline.ts");
    const next = claudeStatuslineSettings(
      original,
      process.execPath,
      script,
      dir,
    );
    expect(
      claudeStatuslineSettings(next, process.execPath, script, dir),
    ).toEqual(next);
    expect(next.hooks).toEqual(original.hooks);
    expect((next.statusLine as { padding: number }).padding).toBe(2);
    const input = JSON.stringify(native);
    const processResult = Bun.spawn(
      ["/bin/sh", "-c", (next.statusLine as { command: string }).command],
      { stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(processResult.stdout).text()).toBe(input);
    expect(await processResult.exited).toBe(0);
    expect((await new ClaudeTelemetry(dir).read(pane))?.telemetry.model).toBe(
      "claude-opus-5-5",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
