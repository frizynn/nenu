import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_PATH,
  CLAUDE_HOOK_TOKEN_ENV,
  CLAUDE_HOOK_TOKEN_FILE,
  CLAUDE_HOOK_TOKEN_HEADER,
  readHookToken,
} from "../bridge/claude-hooks.ts";
import { loadConfig } from "../bridge/config.ts";
import { object } from "../bridge/subagent-files.ts";

// Opt-in installer for Nenu's observer Claude hooks (ADR 0057): `type: "http"` hooks that POST to the
// bridge on loopback, time out fast and continue on failure, so a stopped bridge never slows Claude
// down and no hook ever decides. Run through `herdr plugin action invoke claude-hooks --plugin
// herdr.collie`; `--remove` takes them out again. Other hooks and settings are kept as they are.

export const defaultSettingsPath = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");

const isOurs = (hook: unknown) => typeof object(hook).url === "string" && String(object(hook).url).endsWith(CLAUDE_HOOK_PATH);

/** Settings with Nenu's observer hooks replaced (or, with `url` null, removed); everything else kept. */
export function observerHookSettings(settings: unknown, url: string | null, token: string): Record<string, unknown> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid Claude settings object.");
  const source = object(settings);
  if (source.hooks !== undefined && (!source.hooks || typeof source.hooks !== "object" || Array.isArray(source.hooks))) throw new Error("Invalid Claude hooks object.");
  if (source.env !== undefined && (!source.env || typeof source.env !== "object" || Array.isArray(source.env))) throw new Error("Invalid Claude env object.");
  const hooks = { ...object(source.hooks) };
  for (const [event, matcher] of Object.entries(CLAUDE_HOOK_EVENTS)) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) throw new Error(`Invalid ${event} hooks.`);
    const other = (Array.isArray(existing) ? existing : []).flatMap((entry) => {
      const row = object(entry);
      if (!Array.isArray(row.hooks)) throw new Error(`Invalid ${event} hook row.`);
      const kept = row.hooks.filter((hook) => !isOurs(hook));
      return kept.length ? [{ ...row, hooks: kept }] : [];
    });
    const ours = url === null ? [] : [{
      ...(matcher ? { matcher } : {}),
      hooks: [{
        type: "http",
        url,
        headers: { [CLAUDE_HOOK_TOKEN_HEADER]: `$${CLAUDE_HOOK_TOKEN_ENV}` },
        allowedEnvVars: [CLAUDE_HOOK_TOKEN_ENV],
        timeout: 2,
        onFailure: "continue",
      }],
    }];
    const rows = [...other, ...ours];
    if (rows.length) hooks[event] = rows;
    else delete hooks[event];
  }
  const env = { ...object(source.env) };
  if (url === null) delete env[CLAUDE_HOOK_TOKEN_ENV];
  else env[CLAUDE_HOOK_TOKEN_ENV] = token;
  const next: Record<string, unknown> = { ...source, hooks, env };
  if (!Object.keys(env).length) delete next.env;
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

/**
 * Rewrite a Claude settings file atomically: back up the old bytes, write a temp file, and rename it
 * over the original only if nobody changed the file meanwhile. A missing file starts from `{}`.
 * Returns whether anything changed.
 */
export async function updateClaudeSettings(path: string, update: (settings: unknown) => unknown, backupTag: string): Promise<boolean> {
  const before = await readFile(path, "utf8").catch((error: unknown) => {
    if (object(error).code === "ENOENT") return null;
    throw error;
  });
  const next = JSON.stringify(update(before === null ? {} : JSON.parse(before)), null, 2) + "\n";
  if (next === before) return false;
  if (before !== null) await writeFile(`${path}.${backupTag}-${Date.now()}`, before, { mode: 0o600, flag: "wx" });
  const temporary = `${path}.nenu-${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
  const current = await readFile(path, "utf8").catch(() => null);
  if (current !== before) {
    await unlink(temporary);
    throw new Error("Claude settings changed; retry installation.");
  }
  await rename(temporary, path);
  return true;
}

/** The hook token under the bridge state dir, created once (0600) and reused by every reinstall. */
export async function ensureHookToken(stateDir: string): Promise<string> {
  const existing = await readHookToken(stateDir);
  if (existing) return existing;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const file = await open(join(stateDir, CLAUDE_HOOK_TOKEN_FILE), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(token + "\n");
  } finally {
    await file.close();
  }
  return token;
}

/**
 * The checkout a command hook or status line should run from: COLLIE_PLUGIN_ROOT, else the root Herdr
 * reports for herdr.collie, else this checkout. A worktree that ran the installer is not a stable
 * home: once it is removed, the hook breaks silently. Herdr's root follows `link` and `install`.
 */
export function pluginRoot(script: string, herdrRoot: () => string | null = herdrPluginRoot): string {
  const fallback = resolve(import.meta.dir, "..");
  for (const candidate of [process.env.COLLIE_PLUGIN_ROOT, herdrRoot()]) {
    if (candidate && existsSync(join(candidate, "scripts", script))) return resolve(candidate);
  }
  return fallback;
}

function herdrPluginRoot(): string | null {
  try {
    const result = Bun.spawnSync(["herdr", "plugin", "list", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 4_000 });
    if (result.exitCode !== 0) return null;
    const plugins = object(object(JSON.parse(result.stdout.toString())).result).plugins;
    const nenu = (Array.isArray(plugins) ? plugins : []).map(object).find((p) => p.plugin_id === "herdr.collie");
    return typeof nenu?.plugin_root === "string" ? nenu.plugin_root : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const remove = args.includes("--remove");
  const [settingsPath = defaultSettingsPath(), stateDir = loadConfig().stateDir] = args.filter((a) => a !== "--remove");
  const url = `http://127.0.0.1:${loadConfig().port}${CLAUDE_HOOK_PATH}`;
  const token = remove ? "" : await ensureHookToken(stateDir);
  const changed = (!remove || existsSync(settingsPath)) && await updateClaudeSettings(settingsPath, (s) => observerHookSettings(s, remove ? null : url, token), "nenu-hooks-backup");
  console.log(remove
    ? `Nenu Claude hooks ${changed ? "removed" : "were not installed"}; other hooks preserved.`
    : `Nenu Claude hooks ${changed ? "installed" : "already installed"} (${url}); other hooks preserved. New Claude sessions pick them up.`);
}
