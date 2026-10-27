import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_DOC_MODELS } from "./agent-start.ts";
import { claudeModels, codexModels, discoverPaneModels, startCatalog } from "./models.ts";

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
const id = "11111111-2222-3333-4444-555555555555";
const pane = { agent: "codex", agentSession: { kind: "id" as const, value: id } };
const catalog = (slug: string) => JSON.stringify({ models: [{ slug, visibility: "list", description: "A model", priority: 1 }] });
async function setup() {
  const base = await mkdtemp(join(tmpdir(), "collie-models-")); cleanup.push(base);
  const first = join(base, "first"), second = join(base, "second");
  for (const profile of [first, second]) await mkdir(join(profile, "sessions", "2026", "09", "07"), { recursive: true });
  await writeFile(join(second, "sessions", "2026", "09", "07", `rollout-2026-09-07T09-00-00-${id}.jsonl`), "{}\n");
  const roots = { codex: [join(first, "sessions"), join(second, "sessions")], claude: [] };
  return { base, first, second, roots };
}

describe("model catalog metadata", () => {
  test("Codex filters hidden/invalid rows, sorts priority and emits only bounded display metadata", () => {
    const result = codexModels({ auth: "secret", models: [
      { slug: "second", visibility: "list", priority: 2, description: "x".repeat(900), model_messages: "secret" },
      { slug: "hidden", visibility: "hide" }, { slug: "/bad", visibility: "list" },
      { slug: "first", visibility: "list", priority: 1 }, { slug: "first", visibility: "list" },
    ] });
    expect(result.models.map((row) => row.name)).toEqual(["first", "second"]);
    expect(result.models[1]!.description.length).toBe(600);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(codexModels({})).toEqual({ available: false, models: [] });
  });
  test("Claude identifies alias candidates, adds exact supplemental labels and never exposes account data", () => {
    const result = claudeModels({ oauthAccount: { secret: "credential" }, additionalModelOptionsCache: [
      { value: "claude-fable-5-1[1m]", label: "Fable", description: "From native bootstrap" },
      { label: "Opus" }, { label: "../escape" },
    ] });
    expect(result.models.map((row) => row.name)).toEqual(["Default (recommended)", "Opus", "Sonnet", "Haiku", "Fable"]);
    expect(result.source).toBe("cli-aliases-and-local-cache");
    expect(JSON.stringify(result)).not.toContain("credential");
  });
});

describe("pane model catalog", () => {
  test("uses the profile holding this session rather than the first configured account", async () => {
    const { first, second, roots } = await setup();
    await writeFile(join(first, "models_cache.json"), catalog("wrong-account"));
    await writeFile(join(second, "models_cache.json"), catalog("right-account"));
    expect((await discoverPaneModels(pane, roots)).models[0]!.name).toBe("right-account");
    await writeFile(join(second, "models_cache.json"), catalog("refreshed-model"));
    expect((await discoverPaneModels(pane, roots)).models[0]!.name).toBe("refreshed-model");
  });
  test("does not guess a Codex catalog when the pane has no matching session", async () => {
    const { roots } = await setup();
    expect(await discoverPaneModels({ agent: "codex" }, roots)).toEqual({ available: false, models: [] });
    expect(await discoverPaneModels({ agent: "unknown" }, roots)).toEqual({ available: false, models: [] });
    expect(await discoverPaneModels({ ...pane, agentSession: { kind: "path", value: "/etc/passwd" } }, roots)).toEqual({ available: false, models: [] });
  });
  test("refuses cache symlink escapes and oversized or malformed files", async () => {
    const { base, second, roots } = await setup();
    const target = join(second, "models_cache.json"), outside = join(base, "outside.json");
    await writeFile(outside, catalog("private-model")); await symlink(outside, target);
    expect((await discoverPaneModels(pane, roots)).available).toBe(false);
    await rm(target); await writeFile(target, " ".repeat(1024 * 1024 + 1));
    expect((await discoverPaneModels(pane, roots)).available).toBe(false);
    await writeFile(target, "{broken");
    expect((await discoverPaneModels(pane, roots)).available).toBe(false);
  });
  test("Claude aliases are available without claiming another account's supplemental list", async () => {
    const { base } = await setup();
    await writeFile(join(base, ".claude.json"), JSON.stringify({ additionalModelOptionsCache: [{ label: "Private Model" }] }));
    const result = await discoverPaneModels({ agent: "claude" }, { codex: [], claude: [] }, base);
    expect(result.source).toBe("cli-aliases");
    expect(result.models).toHaveLength(4);
  });
  test("Claude supplemental labels are read only for the session's matching standard profile", async () => {
    const { base } = await setup();
    const project = join(base, ".claude", "projects", "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${id}.jsonl`), "{}\n");
    await writeFile(join(base, ".claude.json"), JSON.stringify({ oauthAccount: { token: "never-return" }, additionalModelOptionsCache: [{ label: "Fable", description: "Cached label" }] }));
    const result = await discoverPaneModels({ ...pane, agent: "claude" }, { codex: [], claude: [join(base, ".claude", "projects")] }, base);
    expect(result.models.at(-1)?.name).toBe("Fable");
    expect(JSON.stringify(result)).not.toContain("never-return");
  });
});

describe("startCatalog", () => {
  test("lists the models the first Codex profile caches, after Codex's default", async () => {
    const { first, roots } = await setup();
    await writeFile(join(first, "models_cache.json"), catalog("gpt-7"));
    const models = await startCatalog(roots);
    expect(models.codex.map((m) => m.id)).toEqual(["default", "gpt-7"]);
    expect(models.claude.map((m) => m.id)).toContain("opus[1m]");
  });

  test("falls back to the documented Codex models where Codex cached none", async () => {
    const { roots } = await setup();
    expect((await startCatalog(roots)).codex.slice(1)).toEqual([...CODEX_DOC_MODELS]);
    expect((await startCatalog({ codex: [] })).codex.slice(1)).toEqual([...CODEX_DOC_MODELS]);
  });
});
