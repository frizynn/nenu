// Which agents may push, from a terminal (ADR 0134). The same file and rules as the ⋯ menu's
// "Notify about this agent" row: the bridge reads a change on its next look, no restart.
//
//   bash scripts/collie-ctl.sh notify list
//   bash scripts/collie-ctl.sh notify on|off [pane id | session/pane id | name]
//   bash scripts/collie-ctl.sh notify supervisors [set '<pattern>,<pattern>' | clear]
//
// With no target, `on`/`off` act on the pane Herdr names: the focused pane a plugin action is invoked
// on (HERDR_PLUGIN_CONTEXT_JSON), else the pane this shell runs in (HERDR_PANE_ID). Run it through
// collie-ctl.sh so the state dir is the supervised bridge's.
import { homedir } from "node:os";
import { join } from "node:path";

import { AgentNotifyStore, type AgentNotifyRow } from "../bridge/agent-notify.ts";
import { loadConfig } from "../bridge/config.ts";
import { deriveConfigRoot, sessionNameFor } from "../bridge/sessions.ts";

const WHY: Record<AgentNotifyRow["why"], string> = {
  existing: "was there before per-agent switches",
  supervisor: "supervisor folder",
  new: "new agent",
  outside: "new agent outside the supervisor folders",
  set: "set by you",
};

export interface Target {
  session: string;
  paneId: string;
}

/** The pane Herdr hands a plugin action or a shell inside a pane, if any. */
export function herdrPane(env: Record<string, string | undefined>): string | undefined {
  try {
    const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "null") as { focused_pane_id?: unknown } | null;
    if (typeof context?.focused_pane_id === "string" && context.focused_pane_id) return context.focused_pane_id;
  } catch {
    /* no context, or not ours to read */
  }
  return env.HERDR_PANE_ID || undefined;
}

/**
 * Which agent `arg` names: `session/pane`, a pane id the bridge has seen in any session (herdr-core's
 * look like `t6`), a Herdr pane id in `session`, or an agent's name (its pane label, Herdr name or
 * Claude session name, any case). Throws with the reason when it names none or several.
 */
export function resolveTarget(arg: string | undefined, rows: readonly AgentNotifyRow[], session: string, env: Record<string, string | undefined>): Target {
  const wanted = arg ?? herdrPane(env);
  if (!wanted) throw new Error("name an agent: a pane id (w1:p2) or its name; `notify list` shows them");
  const slash = wanted.indexOf("/");
  if (slash > 0) return { session: wanted.slice(0, slash), paneId: wanted.slice(slash + 1) };
  const panes = rows.filter((r) => r.paneId === wanted);
  if (panes.length === 1) return { session: panes[0]!.session, paneId: wanted };
  if (panes.length > 1) throw new Error(`pane ${wanted} is in several sessions (${panes.map((r) => r.session).join(", ")}); write session/${wanted}`);
  if (/^[^\s:]+:[^\s:]+$/.test(wanted)) return { session, paneId: wanted };
  const named = rows.filter((r) => r.gone === undefined && r.name?.toLowerCase() === wanted.toLowerCase());
  if (named.length === 1) return { session: named[0]!.session, paneId: named[0]!.paneId };
  if (named.length > 1) throw new Error(`"${wanted}" names ${named.length} agents: ${named.map((r) => `${r.session}/${r.paneId}`).join(", ")}; use one`);
  throw new Error(`no agent named "${wanted}"; \`notify list\` shows them`);
}

export function formatList(rows: readonly AgentNotifyRow[], patterns: readonly string[], home = homedir()): string {
  const short = (p?: string) => (p && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p ?? "");
  const line = (r: AgentNotifyRow) =>
    [r.on ? "on " : "off", `${r.session}/${r.paneId}`, r.name ?? r.workspace ?? "", short(r.cwd), WHY[r.why]];
  const table = (list: readonly AgentNotifyRow[]) => {
    const cells = list.map(line);
    const widths = cells[0]?.map((_, i) => Math.max(...cells.map((c) => c[i]!.length))) ?? [];
    return cells.map((c) => `  ${c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]!))).join("  ")}`).join("\n");
  };
  const here = rows.filter((r) => r.gone === undefined);
  const gone = rows.filter((r) => r.gone !== undefined);
  return [
    supervisorsLine(patterns),
    "",
    here.length ? table(here) : "  no agents seen yet",
    ...(gone.length ? ["", "Closed, kept for a week in case Herdr restores them:", table(gone)] : []),
  ].join("\n");
}

export function supervisorsLine(patterns: readonly string[]): string {
  return patterns.length
    ? `New agents start with notifications on only in: ${patterns.join(", ")}  (\`notify supervisors clear\` turns this off)`
    : "Every new agent starts with notifications on  (\`notify supervisors set '<folders>'\` starts new ones on only there)";
}

/** `set`'s argument: comma-separated whole-path patterns; nothing in it is an error, not a silent clear. */
export function parsePatterns(arg: string | undefined): string[] {
  const patterns = (arg ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (patterns.length === 0) throw new Error("usage: notify supervisors set '~/folder/*,~/other'  (use `clear` to turn the rule off)");
  for (const p of patterns) if (!p.startsWith("/") && !p.startsWith("~/") && p !== "~" && p !== "**" && !p.startsWith("**/")) throw new Error(`"${p}" is not a whole path: start it with /, ~/ or **/`);
  return patterns;
}

if (import.meta.main) {
  const [verb = "list", arg, more, ...extra] = process.argv.slice(2);
  const cfg = loadConfig();
  const store = AgentNotifyStore.at(cfg.stateDir);
  const session = sessionNameFor(cfg.socketPath, deriveConfigRoot(cfg.socketPath));
  try {
    // An unquoted list (`set ~/a, ~/b`) arrives as several arguments: refuse it rather than keep the first.
    const allowed = verb === "supervisors" && arg === "set" ? 2 : verb === "list" ? 0 : 1;
    if ([arg, more, ...extra].filter((a) => a !== undefined).length > allowed) throw new Error("too many arguments; quote the folder list: notify supervisors set '~/a/*,~/b'");
    if (verb === "list") {
      console.log(formatList(store.list(), store.supervisors()));
    } else if (verb === "supervisors") {
      if (arg === "set") store.setSupervisors(parsePatterns(more));
      else if (arg === "clear") store.setSupervisors([]);
      else if (arg !== undefined) throw new Error("usage: notify supervisors [set '<folders>' | clear]");
      console.log(supervisorsLine(store.supervisors()));
      if (arg) console.log("  Agents already known keep their switch; the rule decides agents first seen from now on.");
    } else if (verb === "on" || verb === "off") {
      const rows = store.list();
      const target = resolveTarget(arg, rows, session, process.env);
      // A session the bridge never saw would keep its entry forever: nothing reconciles it.
      if (target.session !== session && !store.sessions().includes(target.session)) throw new Error(`no Herdr session "${target.session}" seen by the bridge`);
      const known = rows.find((r) => r.session === target.session && r.paneId === target.paneId);
      const row = store.set(target.session, target.paneId, verb === "on");
      const label = known?.name ?? known?.workspace ?? "";
      console.log(`✓ notifications ${row.on ? "on" : "off"} for ${target.session}/${target.paneId}${label ? ` (${label})` : ""}`);
      if (!known) console.log("  The bridge has not seen this pane yet; the choice waits for it.");
    } else {
      throw new Error("usage: notify {list | on [agent] | off [agent] | supervisors [set '<folders>' | clear]}");
    }
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    console.error(`  state: ${join(cfg.stateDir, "agent-notify.json")}`);
    process.exit(1);
  }
}
