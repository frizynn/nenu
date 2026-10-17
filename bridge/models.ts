import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { containedRealpath } from "./journal/files.ts";
import { codexJournal } from "./journal/codex.ts";
import { claudeJournal } from "./journal/claude.ts";
import type { JournalRoots } from "./journal/registry.ts";
import type { AgentView } from "./types.ts";

export interface ModelCatalog { available: boolean; models: Array<{ name: string; description: string }>; source?: string }
const unavailable = (): ModelCatalog => ({ available: false, models: [] });
const MAX_BYTES = 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : "";
const cache = new Map<string, { size: number; mtime: number; value: Record<string, unknown> }>();

async function metadata(path: string, root: string): Promise<Record<string, unknown>> {
  const canonical = await containedRealpath(path, root);
  if (!canonical) return {};
  const info = await stat(canonical).catch(() => null);
  if (!info?.isFile() || info.size > MAX_BYTES) return {};
  const previous = cache.get(canonical);
  if (previous?.size === info.size && previous.mtime === info.mtimeMs) return previous.value;
  try {
    const data = object(JSON.parse(await Bun.file(canonical).slice(0, MAX_BYTES + 1).text()));
    // Keep only display metadata in the cache: both CLI files also contain unrelated private data.
    const value: Record<string, unknown> = {
      models: Array.isArray(data.models) ? data.models.slice(0, 100).map((entry) => {
        const row = object(entry);
        return { slug: row.slug, visibility: row.visibility, priority: row.priority, description: clean(row.description, 600) };
      }) : undefined,
      additionalModelOptionsCache: Array.isArray(data.additionalModelOptionsCache) ? data.additionalModelOptionsCache.slice(0, 100).map((entry) => {
        const row = object(entry);
        return { label: clean(row.label, 128), description: clean(row.description, 600) };
      }) : undefined,
    };
    cache.set(canonical, { size: info.size, mtime: info.mtimeMs, value });
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return value;
  } catch { return {}; }
}

export function codexModels(data: unknown): ModelCatalog {
  const rows = object(data).models;
  if (!Array.isArray(rows)) return unavailable();
  const names = new Set<string>();
  const models = rows.slice(0, 100).map(object).filter((row) => row.visibility === "list")
    .sort((a, b) => (typeof a.priority === "number" ? a.priority : 999) - (typeof b.priority === "number" ? b.priority : 999))
    .flatMap((row) => {
      const name = typeof row.slug === "string" ? row.slug : "";
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || names.has(name)) return [];
      names.add(name);
      return [{ name, description: clean(row.description, 600) }];
    });
  return { available: models.length > 0, models, source: "local-cache" };
}

/** CLI aliases are candidates, not a complete entitlement list. These labels/aliases are present
 * in Claude Code's native model picker; the browser must revalidate its chosen row before Apply.
 * An alias carries no description: which version it means is the CLI's to say, and the picker shows
 * it once the agent reports it or its own picker lists it.
 */
export function claudeModels(data: unknown = {}): ModelCatalog {
  const models = [
    { name: "Default (recommended)", description: "Use the agent's configured default" },
    { name: "Opus", description: "" },
    { name: "Sonnet", description: "" },
    { name: "Haiku", description: "" },
  ];
  const extra = object(data).additionalModelOptionsCache;
  if (Array.isArray(extra)) for (const entry of extra.slice(0, 96)) {
    const row = object(entry), name = clean(row.label, 128);
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9 .()[\]_-]*$/.test(name) || models.some((model) => model.name === name)) continue;
    models.push({ name, description: clean(row.description, 600) });
  }
  return { available: true, models, source: models.length > 4 ? "cli-aliases-and-local-cache" : "cli-aliases" };
}

/** Resolve the pane's reported session against configured journal roots, rather than assuming all
 * panes share the bridge process's CLI account/home. No client path, subprocess, or network request.
 */
export async function discoverPaneModels(pane: Pick<AgentView, "agent" | "agentSession">, roots: Pick<JournalRoots, "codex" | "claude">, home = homedir()): Promise<ModelCatalog> {
  if (pane.agent !== "codex" && pane.agent !== "claude") return unavailable();
  if (pane.agentSession) for (const root of roots[pane.agent].slice(0, 8)) {
    const adapter = pane.agent === "codex" ? codexJournal(root) : claudeJournal(root);
    if (!await adapter.source.resolve(pane.agentSession)) continue;
    const profile = dirname(root);
    if (pane.agent === "codex") return codexModels(await metadata(join(profile, "models_cache.json"), profile));
    // The standard Claude profile keeps supplemental options in ~/.claude.json, not settings.
    // Custom profiles are not assumed to share that account's cache.
    const realProfile = await realpath(profile).catch(() => null);
    const standardProfile = await realpath(join(home, ".claude")).catch(() => null);
    return claudeModels(realProfile !== null && realProfile === standardProfile ? await metadata(join(home, ".claude.json"), home) : {});
  }
  return pane.agent === "claude" ? claudeModels() : unavailable();
}
