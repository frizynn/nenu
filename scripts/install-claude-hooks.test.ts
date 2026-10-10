import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLAUDE_HOOK_EVENTS, readHookToken } from "../bridge/claude-hooks.ts";
import { ensureHookToken, observerHookSettings, pluginRoot, setObserverHooks, updateClaudeSettings } from "./install-claude-hooks.ts";

const URL = "http://127.0.0.1:8787/api/hooks/claude";

test("observer hooks are http, short, non-blocking and token-gated through allowedEnvVars", () => {
  const next = observerHookSettings({}, URL, "tok");
  const hooks = next.hooks as Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
  expect(Object.keys(hooks).sort()).toEqual(Object.keys(CLAUDE_HOOK_EVENTS).sort());
  expect(hooks.PreToolUse![0]!.matcher).toBe("AskUserQuestion|ExitPlanMode");
  expect(hooks.Stop![0]!.matcher).toBeUndefined();
  for (const rows of Object.values(hooks)) {
    expect(rows[0]!.hooks).toEqual([{
      type: "http", url: URL, headers: { "x-nenu-hook-token": "$NENU_HOOK_TOKEN" },
      allowedEnvVars: ["NENU_HOOK_TOKEN"], timeout: 2, onFailure: "continue",
    }]);
  }
  expect(next.env).toEqual({ NENU_HOOK_TOKEN: "tok" });
});

test("existing hooks and settings survive install, reinstall and removal", () => {
  const original = {
    model: "opus",
    env: { KEEP: "1" },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "herdr" }] }],
    },
  };
  const once = observerHookSettings(original, URL, "tok");
  expect(observerHookSettings(once, URL, "tok")).toEqual(once);
  const moved = observerHookSettings(once, "http://127.0.0.1:8797/api/hooks/claude", "tok");
  expect(JSON.stringify(moved)).not.toContain(":8787");
  expect((moved.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);
  expect(observerHookSettings(once, null, "")).toEqual(original);
});

test("a malformed settings shape is refused rather than rewritten", () => {
  expect(() => observerHookSettings([], URL, "t")).toThrow();
  expect(() => observerHookSettings({ hooks: { Stop: {} } }, URL, "t")).toThrow();
  expect(() => observerHookSettings({ env: "x" }, URL, "t")).toThrow();
});

test("updateClaudeSettings backs up, writes atomically and refuses a concurrent edit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-settings-"));
  try {
    const path = join(dir, "settings.json");
    await writeFile(path, '{"model":"x"}\n');
    expect(await updateClaudeSettings(path, (s) => ({ ...(s as object), a: 1 }), "bk")).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: "x", a: 1 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await updateClaudeSettings(path, (s) => s, "bk")).toBe(false);
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith("settings.json.bk-"))).toHaveLength(1);
    await expect(updateClaudeSettings(path, (s) => {
      Bun.spawnSync(["sh", "-c", `printf '{}' > '${path}'`]);
      return { ...(s as object), b: 2 };
    }, "bk")).rejects.toThrow("changed");
    expect(await readFile(path, "utf8")).toBe("{}");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const fresh = join(dir, "fresh", "settings.json");
    await mkdir(join(dir, "fresh"));
    expect(await updateClaudeSettings(fresh, (s) => s, "bk")).toBe(true);
    expect(await readFile(fresh, "utf8")).toBe("{}\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hook token is created once, private, and reused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-token-"));
  try {
    const state = join(dir, "state");
    const token = await ensureHookToken(state);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await ensureHookToken(state)).toBe(token);
    expect((await stat(join(state, "claude-hooks.token"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removing the hooks deletes the token, so the bridge refuses later deliveries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-hooks-remove-"));
  try {
    const settings = join(dir, "settings.json");
    expect(await setObserverHooks(settings, dir, URL)).toBe(true);
    const token = await readHookToken(dir);
    expect(token).not.toBe("");
    await Bun.sleep(2); // each rewrite backs up to a millisecond-stamped name
    expect(await setObserverHooks(settings, dir, null)).toBe(true);
    expect(await readHookToken(dir)).toBe("");
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({});
    await Bun.sleep(2);
    expect(await setObserverHooks(settings, dir, URL)).toBe(true);
    expect(await readHookToken(dir)).not.toBe(token);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pluginRoot prefers the checkout Herdr reports over the one running the installer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-root-"));
  const saved = process.env.COLLIE_PLUGIN_ROOT;
  delete process.env.COLLIE_PLUGIN_ROOT;
  try {
    await mkdir(join(dir, "scripts"));
    await writeFile(join(dir, "scripts", "subagent-hook.ts"), "");
    expect(pluginRoot("subagent-hook.ts", () => dir)).toBe(resolve(dir));
    expect(pluginRoot("claude-statusline.ts", () => dir)).toBe(resolve(import.meta.dir, ".."));
    expect(pluginRoot("subagent-hook.ts", () => null)).toBe(resolve(import.meta.dir, ".."));
  } finally {
    if (saved !== undefined) process.env.COLLIE_PLUGIN_ROOT = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
